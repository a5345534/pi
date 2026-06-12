import { getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	ownerCommands: [] as Array<{ sessionId: string; command: unknown }>,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

vi.mock("../src/core/session-owner-adapter.js", () => ({
	createAgentSessionOwner: () => ({
		ownerId: "test-rpc-owner",
		writePolicy: "single-owner",
		listSessions: async () => [],
		createSession: async () => {
			throw new Error("Unexpected createSession call");
		},
		openSession: async () => {
			throw new Error("Unexpected openSession call");
		},
		forkSession: async () => {
			throw new Error("Unexpected forkSession call");
		},
		closeSession: async () => {},
		sendCommand: async (sessionId: string, command: unknown) => {
			rpcIo.ownerCommands.push({ sessionId, command });
		},
		getSnapshot: async () => {
			throw new Error("Unexpected getSnapshot call");
		},
		subscribe: () => () => {},
	}),
}));

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(): AgentSessionRuntime {
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	return {
		session: {
			sessionId: "rpc-owner-session",
			bindExtensions: async () => {},
			subscribe: () => () => {},
			agent: {
				subscribe: () => () => {},
				waitForIdle: async () => {},
			},
			modelRegistry: {
				getAvailable: async () => [model],
			},
			sessionManager: {
				getCwd: () => process.cwd(),
			},
		},
		setRebindSession: () => {},
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
}

describe("RPC session client migration", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.ownerCommands = [];
	});

	it("routes low-risk commands through the session client contract", async () => {
		const runtimeHost = createRuntimeHost();
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found");
		}

		rpcIo.lineHandler!(
			JSON.stringify({ id: "model-1", type: "set_model", provider: model.provider, modelId: model.id }),
		);
		rpcIo.lineHandler!(JSON.stringify({ id: "thinking-1", type: "set_thinking_level", level: "high" }));
		rpcIo.lineHandler!(JSON.stringify({ id: "abort-1", type: "abort" }));

		await vi.waitFor(() => {
			expect(rpcIo.ownerCommands).toHaveLength(3);
		});

		expect(rpcIo.ownerCommands).toEqual(
			expect.arrayContaining([
				{
					sessionId: "rpc-owner-session",
					command: {
						type: "model.change",
						commandId: "model-1",
						model: { providerId: model.provider, modelId: model.id, displayName: model.name },
					},
				},
				{
					sessionId: "rpc-owner-session",
					command: { type: "thinking.change", commandId: "thinking-1", thinking: { level: "high" } },
				},
				{
					sessionId: "rpc-owner-session",
					command: { type: "turn.abort", commandId: "abort-1" },
				},
			]),
		);
		expect(parseOutputLines()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "model-1", type: "response", command: "set_model", success: true }),
				expect.objectContaining({
					id: "thinking-1",
					type: "response",
					command: "set_thinking_level",
					success: true,
				}),
				expect.objectContaining({ id: "abort-1", type: "response", command: "abort", success: true }),
			]),
		);
	});
});
