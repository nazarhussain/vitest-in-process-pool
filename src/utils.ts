import fs from "node:fs/promises";
import mm from "micromatch";
import type {
  EnvironmentOptions,
  TestProject,
  TestSpecification,
  TransformModePatterns,
  VitestEnvironment,
  WorkspaceProject,
} from "vitest/node";
import type { ContextRPC, ContextTestEnvironment, SerializedConfig} from "vitest";
import { type Environment, builtinEnvironments } from "vitest/environments";

export function groupBy<T, K extends string | number | symbol>(
  collection: T[],
  iteratee: (item: T) => K,
): Record<K, T[]> {
  return collection.reduce((acc, item) => {
    const key = iteratee(item)
    acc[key] ||= []
    acc[key].push(item)
    return acc
  }, {} as Record<K, T[]>)
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

export async function groupFilesByEnv(
  files: Array<TestSpecification>,
): Promise<Record<string, {
    file: { filepath: string; testLocations: number[] | undefined }
    project: TestProject
    environment: ContextTestEnvironment
  }[]>> {
  const filesWithEnv = await Promise.all(
    files.map(async ({ moduleId: filepath, project, testLines }) => {
      const code = await fs.readFile(filepath, 'utf-8')

      // 1. Check for control comments in the file
      let env = code.match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/)?.[1]
      // 2. Check for globals
      if (!env) {
        for (const [glob, target] of project.config.environmentMatchGlobs
          || []) {
          if (mm.isMatch(filepath, glob, { cwd: project.config.root })) {
            env = target
            break
          }
        }
      }
      // 3. Fallback to global env
      env ||= project.config.environment || 'node'

      const transformMode = getTransformMode(
        project.config.testTransformMode,
        filepath,
      )

      let envOptionsJson = code.match(/@(?:vitest|jest)-environment-options\s+(.+)/)?.[1]
      if (envOptionsJson?.endsWith('*/')) {
        // Trim closing Docblock characters the above regex might have captured
        envOptionsJson = envOptionsJson.slice(0, -2)
      }

      const envOptions = JSON.parse(envOptionsJson || 'null')
      const envKey = env === 'happy-dom' ? 'happyDOM' : env
      const environment: ContextTestEnvironment = {
        name: env as VitestEnvironment,
        transformMode,
        options: envOptions
          ? ({ [envKey]: envOptions } as EnvironmentOptions)
          : null,
      }
      return {
        file: {
          filepath,
          testLocations: testLines,
        },
        project,
        environment,
      }
    }),
  )

  return groupBy(filesWithEnv, ({ environment }) => environment.name)
}

export function loadEnvironment(
  ctx: ContextRPC,
): Environment {
  const name = ctx.environment.name;
  if (name in builtinEnvironments) {
    return builtinEnvironments[name as keyof typeof builtinEnvironments];
  }

  throw new Error("Custom Environment is not yet supported");
}

const REGEXP_WRAP_PREFIX = '$$vitest:'

/**
 * Prepares `SerializedConfig` for serialization, e.g. `node:v8.serialize`
 */
export function wrapSerializableConfig(config: SerializedConfig) {
  let testNamePattern = config.testNamePattern
  let defines = config.defines

  // v8 serialize does not support regex
  if (testNamePattern && typeof testNamePattern !== 'string') {
    testNamePattern
      = `${REGEXP_WRAP_PREFIX}${testNamePattern.toString()}` as unknown as RegExp
  }

  // v8 serialize drops properties with undefined value
  if (defines) {
    defines = { keys: Object.keys(defines), original: defines }
  }

  return {
    ...config,
    testNamePattern,
    defines,
  } as SerializedConfig
}

export function getUniqueProjects(
  specs: TestSpecification[]
): WorkspaceProject[] {
  const projects = new Set<WorkspaceProject>();
  for (const spec of specs) {
    projects.add(spec.project);
  }
  return [...projects];
}

const configs = new WeakMap<TestProject, SerializedConfig>()
  export function getConfig (project: TestProject): SerializedConfig  {
    if (configs.has(project)) {
      return configs.get(project)!
    }

    const _config = project.serializedConfig;
    const config = wrapSerializableConfig(_config)

    configs.set(project, config)
    return config
  }