import {
  RuntimeRPC,
  WorkerGlobalState,
  ContextTestEnvironment,
  ContextRPC,
  CancelReason,
} from "vitest";
import {
  createMethodsRPC,
  WorkspaceProject,
  type ProcessPool,
  type TestSpecification,
  type Vitest,
} from "vitest/node";
import { runBaseTests } from "vitest/workers";
import { createStackString, parseStacktrace } from "vitest/utils";
import {
  getUniqueProjects,
  groupFilesByEnv,
  groupFilesByProject,
  loadEnvironment,
} from "./utils.js";
import { ModuleCacheMap } from "./moduleCacheMap.js";
import { setupInspect } from "./inspector.js";

export default function createInProcessPool(
  ctx: Vitest,
  opts: { execArgv: string[]; env: Record<string, unknown> }
): ProcessPool {
  return {
    name: "in-process-pool",
    async runTests(
      specs: TestSpecification[],
      invalidates?: string[]
    ): Promise<void> {
      // TODO: don't rely on reassigning process.exit
      // https://github.com/vitest-dev/vitest/pull/4441#discussion_r1443771486
      const exit = process.exit;

      try {
        await execute({ name: "run", ctx, specs, invalidates });
      } finally {
        process.exit = exit;
      }
    },
    async collectTests(
      specs: TestSpecification[],
      invalidates?: string[]
    ): Promise<void> {
      // TODO: don't rely on reassigning process.exit
      // https://github.com/vitest-dev/vitest/pull/4441#discussion_r1443771486
      const exit = process.exit;

      try {
        await execute({ name: "collect", ctx, specs, invalidates });
      } finally {
        process.exit = exit;
      }
    },
    async close(): Promise<void> {},
  };
}

const projectRpcs = new WeakMap<WorkspaceProject, RuntimeRPC>();
const envsOrder = ["node", "jsdom", "happy-dom", "edge-runtime"];
type WorkerRpc = WorkerGlobalState["rpc"];

async function execute({
  name,
  ctx,
  specs,
  invalidates,
}: {
  name: "run" | "collect";
  ctx: Vitest;
  specs: TestSpecification[];
  invalidates?: string[];
}) {
  const projects = getUniqueProjects(specs);
  for (const project of projects) {
    projectRpcs.set(project, createMethodsRPC(project));
  }

  const filesByEnv = await groupFilesByEnv(specs);
  const envs = envsOrder.concat(
    Object.keys(filesByEnv).filter((env) => !envsOrder.includes(env))
  );

  for (const env of envs) {
    const envFiles = filesByEnv[env];
    if (!envFiles?.length) continue;

    const filesByProjects = await groupFilesByProject(envFiles);

    for (const p of Object.keys(filesByProjects)) {
      const files = filesByProjects[p];

      await executeFiles({
        ctx,
        name,
        project: files[0].project,
        environment: files[0].environment,
        files: files.map((f) => f.file.filepath),
        invalidates,
      });
    }
  }
}

async function executeFiles({
  ctx,
  project,
  files,
  name,
  environment,
  invalidates
}: {
  ctx: Vitest;
  name: "run" | "collect";
  project: WorkspaceProject;
  files: string[];
  environment: ContextTestEnvironment;
  invalidates?: string[];
}) {
  project.vitest.state.clearFiles(project, files);
  const context = {
    pool: "in-process-pool",
    worker: "single-worker",
    workerId: 10,
    config: project.serializedConfig,
    files,
    projectName: project.name,
    environment,
    providedContext: project.getProvidedContext(),
    invalidates,
  } satisfies ContextRPC;

  const cleanupInspect = setupInspect(context);

  let setCancel = (_reason: CancelReason) => {};
  const onCancel = new Promise<CancelReason>((resolve) => {
    setCancel = resolve;
  });

  try {
    const rpc = projectRpcs.get(project)!;

    const state = {
      ctx: context,
      moduleCache: {} as unknown as ModuleCacheMap,
      moduleExecutionInfo: new Map(),
      config: context.config,
      onCancel,
      environment: loadEnvironment(context),
      durations: {
        environment: 0,
        prepare: 0,
      },
      rpc: rpc as unknown as WorkerRpc,
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
