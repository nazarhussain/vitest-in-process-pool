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
import { setupInspect } from "./inspector.js";

export default function createInProcessPool(
  ctx: Vitest,
  _opts: { execArgv: string[]; env: Record<string, unknown> }
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
        await execute({ name: "run", specs, invalidates });
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
        await execute({ name: "collect", specs, invalidates });
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
  specs,
  invalidates,
}: {
  name: "run" | "collect";
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
        name,
        project: files[0].project,
        environment: envFiles[0].environment,
        specs: files,
        invalidates,
      });
    }
  }
}

async function executeFiles({
  project,
  specs,
  name,
  environment,
  invalidates
}: {
  name: "run" | "collect";
  project: WorkspaceProject;
  specs: TestSpecification[];
  environment: ContextTestEnvironment;
  invalidates?: string[];
}) {
  project.vitest.state.clearFiles(project, specs.map(s => s.moduleId));
  const context = {
    pool: "in-process-pool",
    worker: "single-worker",
    workerId: 10,
    config: project.serializedConfig,
    files: specs.map(s => s.moduleId),
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
      // This cache map is replaced in `runBaseTests` anyway so we don't need it here       
      moduleCache: {} as WorkerGlobalState['moduleCache'],
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
