import type {
  RuntimeRPC,
  WorkerGlobalState,
  ContextTestEnvironment,
  ContextRPC,
  CancelReason,
  SerializedConfig,
} from "vitest";
import {
  createMethodsRPC,
  type WorkspaceProject,
  type ProcessPool,
  type TestSpecification,
  type Vitest,
  type TestProject,
  type RunnerTask,
} from "vitest/node";
import type { Awaitable } from "vitest/utils";
import { runBaseTests } from "vitest/workers";
import { createStackString, parseStacktrace } from "vitest/utils";
import {
  getConfig,
  getUniqueProjects,
  groupBy,
  groupFilesByEnv,
  loadEnvironment,
} from "./utils.js";
import { setupInspect } from "./inspector.js";

export type RunWithFiles = (
  files: TestSpecification[],
  invalidates?: string[]
) => Awaitable<void>;

interface FileSpecification {
  filepath: string;
  testLocations: number[] | undefined;
}

export default function createInProcessPool(
  ctx: Vitest,
  _opts: { execArgv: string[]; env: Record<string, unknown> }
): ProcessPool {
  const originalUpdateId = ctx.state.updateId;

  const runWithFiles = (name: "run" | "collect"): RunWithFiles => {
    let id = 0;

    if (name === "run") {
      ctx.state.updateId = (task: RunnerTask, project: TestProject) => {
        ctx.state.idMap.delete(task.id);
        originalUpdateId.call(ctx.state, task, project);
      };
    }

    async function runFiles(
      project: TestProject,
      config: SerializedConfig,
      files: FileSpecification[],
      environment: ContextTestEnvironment,
      invalidates: string[] = []
    ) {
      const prepareStart = Date.now();
      const paths = files.map((f) => f.filepath);
      // ctx.state.clearFiles(project, paths);

      const workerId = ++id;
      const rpcContext = {
        pool: "in-process-pool",
        worker: "single-worker",
        workerId,
        config,
        files,
        projectName: project.name,
        environment,
        providedContext: project.getProvidedContext(),
        invalidates,
      } satisfies ContextRPC;

      const cleanupInspect = setupInspect(rpcContext);

      let setCancel = (_reason: CancelReason) => {};
      const onCancel = new Promise<CancelReason>((resolve) => {
        setCancel = resolve;
      });

      try {
        const rpc = projectRpcs.get(project);
        const beforeEnvironmentTime = Date.now();
        const environment = await loadEnvironment(rpcContext);

        if (rpcContext.environment.transformMode) {
          environment.transformMode = rpcContext.environment.transformMode;
        }

        const state = {
          ctx: rpcContext,
          // This cache map is replaced in `runBaseTests` anyway so we don't need it here
          moduleCache: {} as WorkerGlobalState["moduleCache"],
          moduleExecutionInfo: new Map(),
          config: rpcContext.config,
          onCancel,
          environment,
          durations: {
            environment: beforeEnvironmentTime,
            prepare: prepareStart,
          },
          rpc: rpc as unknown as WorkerRpc,
          providedContext: project.getProvidedContext(),
          onFilterStackTrace(stack) {
            return createStackString(parseStacktrace(stack));
          },
        } satisfies WorkerGlobalState;

        await runBaseTests(name, state);
      } catch (error) {
        setCancel("test-failure");
        throw error;
      } finally {
        cleanupInspect();
      }
    }

    return async (specs, invalidates) => {
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

        if (!envFiles?.length) {
          continue;
        }

        const filesByOptions = groupBy(
          envFiles,
          ({ project, environment }) =>
            project.name + JSON.stringify(environment.options)
        );

        for (const files of Object.values(filesByOptions)) {
          const fileSpecs: FileSpecification[] = files.map((f) => ({
            filepath: f.file.filepath,
            testLocations: f.file.testLocations,
          }));

          await runFiles(
            files[0].project,
            getConfig(files[0].project),
            fileSpecs,
            files[0].environment,
            invalidates
          );
        }
      }
    };
  };

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
        await runWithFiles("run")(specs, invalidates);
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
        await runWithFiles("collect")(specs, invalidates);
      } finally {
        process.exit = exit;
      }
    },
    async close(): Promise<void> {
      ctx.logger.log("Closing in-process pool");
    },
  };
}

const projectRpcs = new WeakMap<WorkspaceProject, RuntimeRPC>();
const envsOrder = ["node", "jsdom", "happy-dom", "edge-runtime"];
type WorkerRpc = WorkerGlobalState["rpc"];
