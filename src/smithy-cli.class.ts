import { Command, type ParseOptions } from "commander";
import type { AnyClient, BaseShape, SmithyClientOptions, SmithyModel } from "./smithy.types.js";
import {
    flattenShape,
    resolveShape,
    parseInputOptions,
    parseJsonRef,
    type LogLevel,
    log,
    parsePath,
} from "./util.js";
import { isReadable } from "stream";
import { createWriteStream } from "fs";
import { writeFile } from "fs/promises";
import { isAbsolute, join } from "path/win32";

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

export type ClientFactory = (options: SmithyClientOptions) => AnyClient | Promise<AnyClient>;

const defaultClientOptions: SmithyClientOptions = {
    maxAttempts: 1,
};

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

    #setLogLevel(options: Record<string, any>): LogLevel {
        process.env.SMITHY_CLI_LOG_LEVEL = options.logLevel || "info";
        return process.env.SMITHY_CLI_LOG_LEVEL as LogLevel;
    }

    async #createClient(options: Record<string, any>): Promise<AnyClient> {
        let metadata: Record<string, any> | undefined;
        if (options.metadata) {
            metadata = parseJsonRef(options.metadata, "Metadata", options);
        }
        return this.#clientFactory({
            ...defaultClientOptions,
            maxAttempts: options.maxAttempts
                ? parseInt(options.maxAttempts, 10)
                : defaultClientOptions.maxAttempts,
            apiKey: { apiKey: options.apiKey },
            token: { token: options.token },
            credentials:
                options.accessKeyId && options.secretAccessKey
                    ? {
                          accessKeyId: options.accessKeyId,
                          secretAccessKey: options.secretAccessKey,
                      }
                    : undefined,
            endpoint: options.endpoint,
            metadata,
        });
    }

    #addClientOptions(command: Command) {
        command
            .option("-A --api-key <key>", "API key for authentication")
            .option("-T --token <token>", "Bearer token for authentication")
            .option(
                "--metadata <json>",
                `Additional metadata passed to the client factory. ${parseJsonRef.description}`,
            )
            .option("-I --access-key-id <id>", "Access key ID for authentication")
            .option("-S --secret-access-key <key>", "Secret access key for authentication")
            .option("-E --endpoint <url>", "Service endpoint")
            .option("-M --max-attempts <number>", "Maximum number of attempts for client requests");
    }

    #initProgram() {
        this.#discoverModuleCommands();

        this.#program
            .name(this.#cliName)
            .description(this.#options.description ?? `CLI for ${this.#cliName}`)
            .version(this.#options.version ?? "0.0.1")
            .option("-L --log-level <level>", "Log level (error, warn, info, debug, verbose)", "info")
            .option("-B --base-dir <path>", "Base directory for resolving relative paths in options");

        this.#program.hook("preAction", (command) => {
            this.#setLogLevel(command.optsWithGlobals());
        });

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
                options = cliCommand.optsWithGlobals();

                log("debug", "Command options for", options);

                let input: Record<string, any>;

                if (options.input) {
                    input = parseJsonRef(options.input, "Input", options);
                } else {
                    input = parseInputOptions(options, fields);
                }

                const client = await this.#createClient(options);

                const res = await client.send(new ModuleCommand(input));
                await this.#handleResponse(commandName, res, options);
            });

            this.#options.handleCommand?.(cliCommand, commandName, operation);

            this.#program.addCommand(cliCommand);
        }

        this.#options.handle?.(this.#program);
    }

    async #handleResponse(commandName: string, response: any, options: Record<string, any>): Promise<void> {
        const writeToFile = options.outputFile
            ? options.outputFile.replace(/{{commandName}}/g, commandName)
            : undefined;
        const outFile = writeToFile ? parsePath(writeToFile, options) : null;
        const outputLength = options.outputLength ? parseInt(options.outputLength, 10) : undefined;

        // BUG binary response includes helper methods like transformToWebStream etc
        if (
            response instanceof Blob ||
            Buffer.isBuffer(response) ||
            response instanceof ArrayBuffer ||
            isReadable(response)
        ) {
            if (outFile) {
                const stream = response instanceof Blob ? response.stream() : response;
                const writeStream = createWriteStream(outFile);
                stream.pipe(writeStream);
                return new Promise<void>((resolve, reject) => {
                    writeStream.on("finish", () => {
                        log("info", `Response written to ${outFile}`);
                        resolve();
                    });
                    writeStream.on("error", (err) => {
                        reject(err);
                    });
                });
            } else {
                log("info", "Binary response received (not displayed)");
            }
        } else {
            let json = JSON.stringify(response, null, 2);

            if (outFile) {
                await writeFile(outFile, json);
                log("info", `Response written to ${outFile}`);
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
