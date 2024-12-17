import fs from "node:fs/promises";
import mm from "micromatch";
import type {
  EnvironmentOptions,
  TestSpecification,
  TransformModePatterns,
  VitestEnvironment,
  WorkspaceProject,
} from "vitest/node";
import type { ContextTestEnvironment, SerializedConfig } from "vitest";

export function groupBy<T, K extends string | number | symbol>(
  collection: T[],
  iteratee: (item: T) => K
) {
  return collection.reduce((acc, item) => {
    const key = iteratee(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

function getTransformMode(
  patterns: TransformModePatterns,
  filename: string
): "web" | "ssr" | undefined {
  if (patterns.web && mm.isMatch(filename, patterns.web)) {
    return "web";
  }
  if (patterns.ssr && mm.isMatch(filename, patterns.ssr)) {
    return "ssr";
  }
  return undefined;
}

export async function groupFilesByEnv(files: Array<TestSpecification>) {
  const filesWithEnv = await Promise.all(
    files.map(async (spec) => {
      const file = spec.moduleId;
      const project = spec.project.workspaceProject;
      const code = await fs.readFile(file, "utf-8");

      // 1. Check for control comments in the file
      let env = code.match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/)?.[1];
      // 2. Check for globals
      if (!env) {
        for (const [glob, target] of project.config.environmentMatchGlobs ||
          []) {
          if (mm.isMatch(file, glob, { cwd: project.config.root })) {
            env = target;
            break;
          }
        }
      }
      // 3. Fallback to global env
      env ||= project.config.environment || "node";

      const transformMode = getTransformMode(
        project.config.testTransformMode,
        file
      );

      let envOptionsJson = code.match(
        /@(?:vitest|jest)-environment-options\s+(.+)/
      )?.[1];
      if (envOptionsJson?.endsWith("*/")) {
        // Trim closing Docblock characters the above regex might have captured
        envOptionsJson = envOptionsJson.slice(0, -2);
      }

      const envOptions = JSON.parse(envOptionsJson || "null");
      const envKey = env === "happy-dom" ? "happyDOM" : env;
      const environment: ContextTestEnvironment = {
        name: env as VitestEnvironment,
        transformMode,
        options: envOptions
          ? ({ [envKey]: envOptions } as EnvironmentOptions)
          : null,
      };
      return {
        file,
        project,
        environment,
      };
    })
  );

  return groupBy(filesWithEnv, ({ environment }) => environment.name);
}

export function getUniqueProjects(
  specs: TestSpecification[]
): WorkspaceProject[] {
  const projects = new Set<WorkspaceProject>();
  for (const spec of specs) {
    projects.add(spec.project.workspaceProject);
  }
  return [...projects];
}

const configs = new WeakMap<WorkspaceProject, SerializedConfig>();
export function getConfig(project: WorkspaceProject): SerializedConfig {
  if (configs.has(project)) {
    return configs.get(project)!;
  }

  const config = project.getSerializableConfig();
  configs.set(project, config);

  return config;
}
