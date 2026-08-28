import { readFileSync } from "fs";
import type { SmithyModel, BaseShape } from "./smithy.types.js";
import { setProperty } from "dot-prop";
import { isAbsolute, resolve } from "path";

export type LogLevel = "debug" | "info" | "error";

const levels: LogLevel[] = ["debug", "info", "error"];

export function log(level: LogLevel, ...message: string[]) {
    let currentLogLevel = (process.env.SMITHY_CLI_LOG_LEVEL as LogLevel) || "info";

    if (!levels.includes(level)) {
        level = "info";
    }
    if (!levels.includes(currentLogLevel)) {
        currentLogLevel = "info";
    }

    const prefix = {
        debug: "[DEBUG]",
        info: "[INFO] ",
        error: "[ERROR]",
    }[level];

    if (levels.indexOf(level) >= levels.indexOf(currentLogLevel)) {
        console.log(prefix, ...message);
    }
}

// Recursively resolve a shape and its members
export function resolveShape(model: SmithyModel, shapeId: string, seen = new Set()): any {
    if (seen.has(shapeId)) return { $ref: shapeId };
    seen.add(shapeId);
    const shape = model.shapes?.[shapeId];
    if (!shape) return { $ref: shapeId };
    if (shape.type === "structure") {
        const members: Record<string, any> = {};
        for (const [memberName, member] of Object.entries(shape.members || {})) {
            members[memberName] = resolveShape(model, member.target, seen);
        }
        // Handle mixins (Smithy "mixins" are like inheritance)
        if (shape.mixins) {
            for (const mixin of shape.mixins) {
                const mixinShape = resolveShape(model, mixin.target, seen);
                Object.assign(members, mixinShape.members || {});
            }
        }
        return {
            type: "structure",
            members,
            traits: shape.traits || {},
        };
    }
    if (shape.type === "list") {
        return {
            type: "list",
            member: resolveShape(model, shape.member!.target, seen),
            traits: shape.traits || {},
        };
    }
    if (shape.type === "map") {
        return {
            type: "map",
            key: resolveShape(model, shape.key!.target, seen),
            value: resolveShape(model, shape.value!.target, seen),
            traits: shape.traits || {},
        };
    }
    if (shape.type === "enum") {
        return {
            type: "enum",
            members: Object.keys(shape.members || {}),
            traits: shape.traits || {},
        };
    }
    // Simple types (string, integer, boolean, etc.)
    return {
        type: shape.type,
        traits: shape.traits || {},
    };
}

/**
 * Depth: 1
 */
export function flattenShape(shape: any, prefix = ""): BaseShape[] {
    if (!shape) return [];

    if (shape.type === "structure") {
        let result: BaseShape[] = [];

        for (const [key, member] of Object.entries(shape.members || {})) {
            result.push({ name: key, type: (member as BaseShape)?.type || "unknown" });
        }

        return result;
    }

    if (shape.type === "list") {
        return [{ name: prefix, type: "array" }];
    }

    if (shape.type === "map") {
        return [{ name: prefix, type: "object" }];
    }

    if (shape.type === "enum") {
        return [{ name: prefix, type: "enum" }];
    }

    return [{ name: prefix, type: shape.type }];
}
/**
 * options key -> shape key
 */
function parseInputOption(key: string, fields: BaseShape[]): [parsedKey: string, shape: BaseShape] {
    const keyCapitalized = key.replace(/^inj?/, "");
    const keyLower = keyCapitalized.charAt(0).toLowerCase() + keyCapitalized.slice(1);
    let keyUsed: string | undefined;
    const shape = fields.find((s) => {
        if (s.name === keyCapitalized) {
            keyUsed = keyCapitalized;
            return true;
        }
        if (s.name === keyLower) {
            keyUsed = keyLower;
            return true;
        }
        return false;
    });

    if (!shape || keyUsed === undefined) {
        throw new Error(`Unknown option: ${keyLower}|${keyCapitalized}`);
    }

    return [keyUsed, shape];
}

export function parseInputOptions(options: Record<string, any>, fields: BaseShape[]): Record<string, any> {
    const result: Record<string, any> = {};

    for (let [key, value] of Object.entries(options)) {
        // input options: Parse inline input fragments
        if (/^in[A-Z]/.test(key)) {
            const [parsedKey, shape] = parseInputOption(key, fields);
            setProperty(result, parsedKey, coerceValue(value, shape));
        }
        // json input options: Read input fragment from json file
        else if (/^inj[A-Z]/.test(key)) {
            const [parsedKey, shape] = parseInputOption(key, fields);
            const json = parseJsonRef(value, `Input for ${parsedKey}`, options);
            setProperty(result, parsedKey, coerceValue(json, shape));
        }
    }

    return result;
}

function isPrimitiveSmithyType(type: string) {
    return ["string", "integer", "float", "boolean"].includes(type);
}

function coerceValue(value: unknown, shape: BaseShape): any {
    if (shape.type === "integer") {
        if (Number.isInteger(value)) {
            return value;
        }
        const i = parseInt(value as string, 10);
        if (isNaN(i)) {
            throw new TypeError(`Value for ${shape.name} must be a valid integer`);
        }
        return i;
    }

    if (shape.type === "float") {
        if (typeof value === "number") {
            return value;
        }
        const f = parseFloat(value as string);
        if (isNaN(f)) {
            throw new TypeError(`Value for ${shape.name} must be a valid float`);
        }
        return f;
    }

    if (shape.type === "boolean") {
        return value === "true" || value === "1" || value === 1 || value === true;
    }

    if (shape.type === "array") {
        if (Array.isArray(value)) {
            return value;
        }

        const parseArrayAsJson = () => {
            try {
                return JSON.parse(value as string);
            } catch (e) {
                throw new TypeError(`Value for ${shape.name} must be a valid JSON array`);
            }
        };

        const primitiveMembers = isPrimitiveSmithyType(shape.type);

        if (primitiveMembers) {
            if (typeof value === "string") {
                const trimmed = value.trim();

                if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                    return parseArrayAsJson();
                } else {
                    return value.split(",").map((v) => coerceValue(v, shape.member!));
                }
            }

            throw new TypeError(`Value for ${shape.name} must be an array or comma-separated string`);
        } else {
            return parseArrayAsJson();
        }
    }

    if (shape.type === "structure") {
        if (typeof value === "string") {
            try {
                return JSON.parse(value);
            } catch (e) {
                throw new TypeError(`Value for ${shape.name} must be a valid JSON string`);
            }
        }
        if (value && typeof value === "object") {
            return value;
        }

        throw new TypeError(`Value for ${shape.name} must be an object`);
    }

    if (shape.type === "map") {
        if (typeof value === "string") {
            try {
                return JSON.parse(value);
            } catch (e) {
                throw new TypeError(`Value for ${shape.name} must be a valid JSON string`);
            }
        }
        if (value && typeof value === "object") {
            return value;
        }
        throw new TypeError(`Value for ${shape.name} must be an object`);
    }

    return value;
}

export function pascalToKebabCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
}

export function parseJsonRef(fileOrJson: string, label: string, options: Record<string, any>): any {
    fileOrJson = fileOrJson.trim();

    if (
        fileOrJson.startsWith('"') ||
        fileOrJson.startsWith("{") ||
        fileOrJson.startsWith("[") ||
        !isNaN(Number(fileOrJson))
    ) {
        try {
            return JSON.parse(fileOrJson);
        } catch (e) {
            throw new TypeError(`${label} is not valid JSON`);
        }
    } else {
        const p = parsePath(fileOrJson, options);

        log("debug", `Reading ${label} from file: ${p}`);

        const content = readFileSync(p, "utf-8");
        try {
            return JSON.parse(content);
        } catch (e) {
            throw new TypeError(`${label} file does not contain valid JSON`);
        }
    }
}

parseJsonRef.description = "Format: A raw JSON object string or a path to a JSON file";

export function parsePath(path: string, options: Record<string, any>): string {
    return isAbsolute(path) ? path : resolve(options.baseDir || process.cwd(), path);
}
