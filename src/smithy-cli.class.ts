import { Command, type ParseOptions } from "commander";
import type { AnyClient, BaseShape, SmithyModel } from "./smithy.types.js";
import { flattenShape, resolveShape, parseInputOptions, parseJsonRef } from "./util.js";
import { isReadable } from "stream";
import { createWriteStream } from "fs";
import { writeFile } from "fs/promises";

export interface SmithyCliOptions {
    /**
     * Handle program after preparing, before parsing.
     */
    handle?: (program: Command) => void;
    /**
     * Handle commands after they are created, before they are added to the program.
     */
    handleCommand?: (command: Command, operationName: string, operation: any) => void;
    /**
     * CLI description
     */
    description?: string;
    /**
     * CLI version
     */
    version?: string;
}

interface AuthOptions {
    /**
     * API key for authentication
     */
    apiKey?: string;
    /**
     * Bearer token for authentication
     */
    bearerToken?: string;
    /**
     * Access key ID for authentication
     */
    accessKeyId?: string;
    /**
     * Secret access key for authentication
     */
    secretAccessKey?: string;
}

interface CommonClientOptions {
    /**
     * Endpoint URL for the client
     */
    endpoint?: string;
    /**
     * Additional metadata
     */
    metadata?: Record<string, any>;
}

interface ClientFactoryOptions extends AuthOptions, CommonClientOptions {
    [key: string]: any;
}

export type ClientFactory = (options: ClientFactoryOptions) => AnyClient | Promise<AnyClient>;

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
        this.#model = model;
        this.#module = clientModule;
        this.#clientFactory = clientFactory;
    }

    start(argv?: string[], options?: ParseOptions) {
        this.#discoverOperations();
        this.#initProgram();
        this.#program.parse(argv ?? process.argv, options);
        return this;
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

    #addCommandOptions(command: Command, fields: BaseShape[]) {
        for (const field of fields) {
            const name = field.name || "root";

            // inline input
            const flag = `--in-${name} <value>`;
            const description = `${field.type}`;
            command.option(flag, description);

            // json input
            const jsonFlag = `--inj-${name} <path>`;
            const jsonDescription = `${field.type}. ${parseJsonRef.description}`;
            command.option(jsonFlag, jsonDescription);
        }

        // Full input. Overrides other input options if provided
        command.option("--input <jsonOrPath>", `Full input. ${parseJsonRef.description}`);
    }

    async #createClientFromOptions(options: any): Promise<AnyClient> {
        let metadata: Record<string, any> | undefined;
        if (options.metadata) {
            metadata = parseJsonRef(options.metadata, "Metadata");
        }
        return this.#clientFactory({
            apiKey: options.apiKey,
            bearerToken: options.bearerToken,
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            endpoint: options.endpoint,
            metadata,
        });
    }

    #addClientOptions(command: Command) {
        command
            .option("--api-key <key>", "API key for authentication")
            .option("--bearer-token <token>", "Bearer token for authentication")
            .option(
                "--metadata <json>",
                `Additional metadata passed to the client factory. ${parseJsonRef.description}`,
            )
            .option("--access-key-id <id>", "Access key ID for authentication")
            .option("--secret-access-key <key>", "Secret access key for authentication")
            .option("-e --endpoint <url>", "Service endpoint");
    }

    #initProgram() {
        this.#discoverModuleCommands();

        this.#program
            .name(this.#cliName)
            .description(this.#options.description ?? `CLI for ${this.#cliName}`)
            .version(this.#options.version ?? "0.0.1");

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
                    "Write output to file instead of stdout. Use {{commandName}} as placeholder for dynamic naming",
                )
                .option(
                    "--output-length <number>",
                    "Truncate output to specified length (for non-file output)",
                );

            this.#addClientOptions(cliCommand);

            const fields = flattenShape(operation.inputShape);
            this.#addCommandOptions(cliCommand, fields);

            cliCommand.action(async (options) => {
                let input: Record<string, any> = {};

                if (options.input) {
                    input = parseJsonRef(options.input, "Input");
                } else {
                    input = parseInputOptions(options, fields);
                }

                const client = await this.#createClientFromOptions(options);

                const res = await client.send(new ModuleCommand(input));
                await this.#handleResponse(
                    commandName,
                    res,
                    options.outputFile,
                    parseInt(options.outputLength) || undefined,
                );
            });

            this.#options.handleCommand?.(cliCommand, commandName, operation);

            this.#program.addCommand(cliCommand);
        }

        this.#options.handle?.(this.#program);
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
