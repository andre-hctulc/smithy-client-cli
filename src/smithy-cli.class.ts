import { Command, type ParseOptions } from "commander";
import type { AnyClient, BaseShape, SmithyModel } from "./smithy.types.js";
import { flattenShape, resolveShape, parseInputOptions, pascalToKebabCase } from "./util.js";
import { isReadable } from "stream";
import { createWriteStream } from "fs";
import { writeFile } from "fs/promises";

export interface SmithyCliOptions {
    handle?: (program: Command) => void;
    handleCommand?: (command: Command, operationName: string, operation: any) => void;
    description?: string;
}

interface AuthOptions {
    apiKey?: string;
    bearerToken?: string;
    data?: Record<string, any>;
    accessKeyId?: string;
    secretAccessKey?: string;
}

export type ClientFactory = (options: AuthOptions & Record<string, any>) => AnyClient | Promise<AnyClient>;

export class SmithyCli {
    #model: SmithyModel;
    #clientFactory: ClientFactory;
    #program = new Command();
    #operations: Record<string, any> = {};
    #module: any;
    #cliName: string;
    #options: SmithyCliOptions;

    constructor(
        cliName: string,
        clientFactory: ClientFactory,
        clientModule: any,
        model: SmithyModel,
        options: SmithyCliOptions = {},
    ) {
        this.#options = options;
        this.#cliName = cliName;
        this.#clientFactory = clientFactory;
        this.#model = model;
        this.#module = clientModule;
        this.#discoverOperations();
    }

    start(argv?: string[], options?: ParseOptions) {
        this.#initProgram();
        this.#program.parse(argv ?? process.argv, options);
    }

    // Discover all operations and their input shapes from the Smithy model
    #discoverOperations() {
        const shapes = this.#model.shapes || {};
        for (const [shapeName, shape] of Object.entries(shapes)) {
            if (shape.type === "operation") {
                const [namespace, opName] = shapeName.split("#");

                const inputTarget = shape.input?.target;
                const outputTarget = shape.output?.target;
                this.#operations[opName] = {
                    inputShape: inputTarget ? resolveShape(this.#model, inputTarget) : null,
                    outputShape: outputTarget ? resolveShape(this.#model, outputTarget) : null,
                    documentation: shape.traits?.["smithy.api#documentation"] || "",
                };
            }
        }
    }

    #moduleCommands: Record<string, any> = {};

    #discoverModuleCommands() {
        Object.entries(this.#module).forEach(([exportName, exportValue]) => {
            if (
                /^[A-Z].*Command$/.test(exportName) &&
                typeof exportValue === "function" &&
                exportValue.prototype &&
                exportValue.prototype.constructor
            ) {
                this.#moduleCommands[exportName] = exportValue;
            }
        });
    }

    #registerOptions(command: Command, fields: BaseShape[]) {
        for (const field of fields) {
            const name = field.name || "root";
            const flag = `--in-${name} <value>`;
            const description = `${field.type}`;
            command.option(flag, description);
        }

        // Optional raw JSON input (VERY useful)
        command.option("--input <json>", "Raw JSON input");
    }

    #initProgram() {
        this.#discoverModuleCommands();

        this.#program
            .name(this.#cliName)
            .description(this.#options.description ?? `CLI for ${this.#cliName}`)
            .version("0.0.1");

        this.#options.handle?.(this.#program);

        for (const [moduleCommandName, ModuleCommand] of Object.entries(this.#moduleCommands)) {
            const commandName = moduleCommandName.replace(/Command$/, "");

            const operation = this.#operations[commandName];
            if (!operation) {
                throw new Error(`No matching operation found in Smithy model for command: ${commandName}`);
            }

            const cliCommand = new Command(commandName)
                .description(operation.documentation || `Execute the ${commandName} command`)
                .option(
                    "-o --output-file <file>",
                    "Write output to file instead of stdout, use {{commandName}} as placeholder for dynamic naming",
                )
                .option(
                    "--output-length <number>",
                    "Truncate output to specified length (for non-file output)",
                )
                .option("--api-key <key>", "API key for authentication")
                .option("--bearer-token <token>", "Bearer token for authentication")
                .option("--auth-data <json>", "Additional JSON data for authentication")
                .option("--access-key-id <id>", "Access key ID for authentication")
                .option("--secret-access-key <key>", "Secret access key for authentication")
                .option("-e --endpoint <url>", "Service endpoint")

            const fields = flattenShape(operation.inputShape);
            this.#registerOptions(cliCommand, fields);

            this.#options.handleCommand?.(cliCommand, commandName, operation);

            cliCommand.action(async (options) => {
                let input: Record<string, any> = {};

                if (options.input) {
                    try {
                        input = JSON.parse(options.input);
                    } catch (e) {
                        throw new Error("Input is not valid JSON");
                    }
                } else {
                    input = parseInputOptions(options, fields);
                }

                let authData: Record<string, any> | undefined;
                if (options.authData) {
                    try {
                        authData = JSON.parse(options.authData);
                    } catch (e) {
                        throw new Error("Auth data is not valid JSON");
                    }
                }

                const client = await this.#clientFactory({
                    ...options,
                    data: authData,
                });

                const res = await client.send(new ModuleCommand(input));
                await this.#handleResponse(
                    commandName,
                    res,
                    options.outputFile,
                    parseInt(options.outputLength) || undefined,
                );
            });

            this.#program.addCommand(cliCommand);
        }
    }

    async #handleResponse(
        commandName: string,
        response: any,
        writeToFile?: string,
        outputLength?: number,
    ): Promise<void> {
        writeToFile = writeToFile ? writeToFile.replace(/{{commandName}}/g, commandName) : undefined;

        // BUG binary response includes helper methods like transformToWebStream etc
        if (
            response instanceof Blob ||
            Buffer.isBuffer(response) ||
            response instanceof ArrayBuffer ||
            isReadable(response)
        ) {
            if (writeToFile) {
                const stream = response instanceof Blob ? response.stream() : response;
                const writeStream = createWriteStream(writeToFile);
                stream.pipe(writeStream);
                return new Promise<void>((resolve, reject) => {
                    writeStream.on("finish", () => {
                        console.log(`Response written to ${writeToFile}`);
                        resolve();
                    });
                    writeStream.on("error", (err) => {
                        reject(err);
                    });
                });
            } else {
                console.log("Binary response received (not displayed)");
            }
        } else {
            let json = JSON.stringify(response, null, 2);

            if (writeToFile) {
                await writeFile(writeToFile, json);
                console.log(`Response written to ${writeToFile}`);
            } else {
                const ol = outputLength ?? 1000;
                const truncated = json.length > ol;
                if (truncated) {
                    json = json.slice(0, ol) + "\n... (truncated)";
                }
                console.log(json);
            }
        }
    }
}
