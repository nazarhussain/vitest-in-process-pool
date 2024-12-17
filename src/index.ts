import {
  CancelReason,
  ContextRPC,
  ContextTestEnvironment,
  SerializedConfig,
  WorkerGlobalState,
  WorkerRPC,
} from "vitest";
import { builtinEnvironments } from "vitest/environments";
import { Environment } from "vitest/environments.js";
import {
  createMethodsRPC,
  TestSpecification,
  Vitest,
  WorkspaceProject,
} from "vitest/node";
import { createStackString, parseStacktrace } from "vitest/utils";
import { runBaseTests } from "vitest/workers";
import { ModuleCacheMap } from "./moduleCacheMap.js";
import { getConfig, getUniqueProjects, groupFilesByEnv } from "./utils.js";
import { setupInspect } from "./inspector.js";

const envsOrder = ["node", "jsdom", "happy-dom", "edge-runtime"];

export default function createThreadsJsPool(
  ctx: Vitest,
  _opts: { execArgv: string[]; env: Record<string, unknown> }
) {
  return {
    name: "in-process",
    runTests: async (specs: TestSpecification[], invalidates: []) => {
      return execute({ name: "run", ctx, specs, invalidates });
    },
    collectTests: async (specs: TestSpecification[], invalidates: []) => {
      return execute({ name: "collect", ctx, specs, invalidates });
    },
    close: async () => {
      ctx.logger.console.debug("closing pool");
    },
  };
}

const projectRpcs = new WeakMap<WorkspaceProject, WorkerRPC>();

async function execute({
  ctx,
  name,
  specs,
  invalidates,
}: {
  ctx: Vitest;
  name: "run" | "collect";
  specs: TestSpecification[];
  invalidates: string[];
}) {
  const projects = getUniqueProjects(specs);
  for (const project of projects) {
    projectRpcs.set(project, createMethodsRPC(project) as unknown as WorkerRPC);
  }

  const filesByEnv = await groupFilesByEnv(specs);
  const envs = envsOrder.concat(
    Object.keys(filesByEnv).filter((env) => !envsOrder.includes(env))
  );

  for (const env of envs) {
    const files = filesByEnv[env];

    if (!files?.length) continue;

    await executeFiles({
      name,
      ctx,
      project: files[0].project,
      config: getConfig(files[0].project),
      files: files.map((f) => f.file),
      environment: files[0].environment,
      invalidates,
    });
  }
}

async function executeFiles({
  ctx,
  project,
  files,
  name,
  environment,
}: {
  ctx: Vitest;
  name: "run" | "collect";
  project: WorkspaceProject;
  config: SerializedConfig;
  files: string[];
  environment: ContextTestEnvironment;
  invalidates: string[];
}) {
  const context = {
    pool: "",
    worker: null as any,
    workerId: 10,
    config: getConfig(project),
    files,
    projectName: project.getName(),
    environment,
    providedContext: project.getProvidedContext(),
  } satisfies ContextRPC;

  const cleanupInspect = setupInspect(context);

  ctx.state.clearFiles(project, files);

  let setCancel = (_reason: CancelReason) => {};
  const onCancel = new Promise<CancelReason>((resolve) => {
    setCancel = resolve;
  });

  try {
    const rpc = projectRpcs.get(project)!;

    const state = {
      ctx: context,
      moduleCache: new ModuleCacheMap(),
      config: getConfig(project),
      onCancel,
      environment: await loadEnvironment(context, rpc),
      durations: {
        environment: 0,
        prepare: 0,
      },
      rpc,
      providedContext: project.getProvidedContext(),
      onFilterStackTrace(stack) {
        return createStackString(parseStacktrace(stack));
      },
    } satisfies WorkerGlobalState;

    await runBaseTests(name, state);
  } catch (err) {
    setCancel("test-failure");
  } finally {
    cleanupInspect();
  }
}

export async function loadEnvironment(
  ctx: ContextRPC,
  _rpc: WorkerRPC
): Promise<Environment> {
  const name = ctx.environment.name;
  if (name in builtinEnvironments) {
    return builtinEnvironments[name as keyof typeof builtinEnvironments];
  }

  throw new Error("Custom Environment is not yet supported");
}
