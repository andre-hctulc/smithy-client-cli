import type { Client } from "@smithy/smithy-client";

export type SmithyTarget = {
    target: string;
};

export interface SmithyModel {
    shapes: Record<
        string,
        {
            type: string;
            input?: SmithyTarget;
            output?: SmithyTarget;
            traits?: Record<string, any>;
            mixins?: Array<SmithyTarget>;
            members?: Record<string, SmithyTarget>;
            member?: SmithyTarget;
            key?: SmithyTarget;
            value?: SmithyTarget;
        }
    >;
}

export type AnyClient = Client<any, any, any, any>;

// Resolved shape
export type BaseShape = {
    name: string;
    type: string;
    member?: BaseShape;
    members?: Record<string, BaseShape>;
    value?: BaseShape;
    key?: BaseShape;
    traits?: Record<string, any>;
};

export interface SmithyClientOptions {
    /**
     * Endpoint URL for the client
     */
    endpoint?: string;
    /**
     * Maximum number of attempts for client requests
     */
    maxAttempts?: number;
    /**
     * Api Key for authentication
     */
    apiKey?: { apiKey: string };
    /**
     * Bearer token for authentication
     */
    token?: { token: string };
    credentials?: {
        /**
         * Access key ID for authentication
         */
        accessKeyId: string;
        /**
         * Secret access key for authentication
         */
        secretAccessKey: string;
    };
    /**
     * Additional metadata
     */
    metadata?: Record<string, unknown>;
}
