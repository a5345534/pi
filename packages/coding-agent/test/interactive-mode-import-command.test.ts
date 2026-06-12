import type { SessionCommand } from "@a5345534/pi-session";
import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	sendSessionCommand: (command: SessionCommand) => Promise<void>;
	runClientReplacement: (
		cancelledMessage: string,
		operation: () => Promise<unknown>,
	) => Promise<{ cancelled: boolean }>;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes unquoted path through the session owner import command", async () => {
		const sendSessionCommand = vi.fn(async () => {});
		const runClientReplacement = vi.fn(async (_cancelledMessage: string, operation: () => Promise<unknown>) => {
			await operation();
			return { cancelled: false };
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			sendSessionCommand,
			runClientReplacement,
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(runClientReplacement).toHaveBeenCalledWith("Session import cancelled", expect.any(Function));
		expect(sendSessionCommand).toHaveBeenCalledWith({
			type: "session.import",
			source: { kind: "jsonl-file", path: "path/to/session.jsonl" },
		});
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes unquoted apostrophe path to the session owner import command unchanged", async () => {
		const sendSessionCommand = vi.fn(async () => {});
		const runClientReplacement = vi.fn(async (_cancelledMessage: string, operation: () => Promise<unknown>) => {
			await operation();
			return { cancelled: false };
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			sendSessionCommand,
			runClientReplacement,
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(sendSessionCommand).toHaveBeenCalledWith({
			type: "session.import",
			source: { kind: "jsonl-file", path: "john's/session.jsonl" },
		});
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const sendSessionCommand = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const runClientReplacement = vi.fn(async (_cancelledMessage: string, operation: () => Promise<unknown>) => {
			await operation();
			return { cancelled: false };
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			sendSessionCommand,
			runClientReplacement,
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
