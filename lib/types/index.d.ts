import type z from '@deepseek-ai/schemastery';

export declare const name: string;
export declare const inject: readonly string[];
export declare const Config: z<{
	terse: boolean;
	memory: boolean;
	filter: boolean;
	memoryFile: string;
	memoryMaxItems: number;
	recallLimit: number;
	textMaxChars: number;
	minimumTextChars: number;
}>;
export declare const SettingsSchema: z<{
	terse: boolean;
	memory: boolean;
	filter: boolean;
	recallLimit: number;
}>;
export declare function apply(ctx: unknown, config: unknown): void;
