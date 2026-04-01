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
