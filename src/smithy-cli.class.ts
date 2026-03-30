import { Command, type ParseOptions } from "commander";
import type { AnyClient, BaseShape, SmithyModel } from "./smithy.types.js";
import { flattenShape, resolveShape, parseInputOptions } from "./util.js";
import { isReadable } from "stream";
import { createWriteStream } from "fs";
import { writeFile } from "fs/promises";

export interface SmithyCliOptions {
    handle?: (program: Command) => void;
}

export class SmithyCli {
    #model: SmithyModel;
    #client: AnyClient;
    #program = new Command();
    #operations: Record<string, any> = {};
    #module: any;

    constructor(client: AnyClient, clientModule: any, model: SmithyModel) {
        this.#client = client;
        this.#model = model;
        this.#module = clientModule;
        this.#discoverOperations();
        this.#initProgram();
    }

    start(argv?: string[], options?: ParseOptions) {
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

        const serviceTarget =
            this.#client.config.protocolSettings?.serviceTarget ?? "<service_name_unresolved>";

        this.#program.name(serviceTarget).description(`CLI for ${serviceTarget}`).version("0.0.1");

        for (const [moduleCommandName, ModuleCommand] of Object.entries(this.#moduleCommands)) {
            const commandName = moduleCommandName.replace(/Command$/, "");

            const operation = this.#operations[commandName];
            if (!operation) {
                throw new Error(`No matching operation found in Smithy model for command: ${commandName}`);
            }

            const cliCommand = new Command(moduleCommandName)
                .description(operation.documentation || `Execute the ${commandName} command`)
                .option(
                    "-o --output-file <file>",
                    "Write output to file instead of stdout, use {{commandName}} as placeholder for dynamic naming",
                )
                .option(
                    "--output-length <number>",
                    "Truncate output to specified length (for non-file output)",
                );

            const fields = flattenShape(operation.inputShape);

            this.#registerOptions(cliCommand, fields);

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

                const res = await this.#client.send(new ModuleCommand(input));
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
