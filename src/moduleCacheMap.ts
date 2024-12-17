// This code is adapted from [Vitest] (https://github.com/vitest-dev/vitest)
// Licensed under [MIT] (https://github.com/vitest-dev/vitest?tab=MIT-1-ov-file#readme)

const prefixedBuiltins = new Set(['node:test'])

export const isWindows = process.platform === 'win32';

export function normalizeModuleId(id: string) {
  // unique id that is not available as "test"
  if (prefixedBuiltins.has(id)) {
    return id
  }
  return id
    .replace(/\\/g, '/')
    .replace(/^\/@fs\//, isWindows ? '' : '/')
    .replace(/^file:\//, '/')
    .replace(/^node:/, '')
    .replace(/^\/+/, '/')
}

export interface SourceMapV3 {
    file?: string | null;
    names: string[];
    sourceRoot?: string;
    sources: (string | null)[];
    sourcesContent?: (string | null)[];
    version: 3;
    ignoreList?: number[];
}

export interface EncodedSourceMap extends SourceMapV3 {
  mappings: string;
}

export interface ModuleCache {
  promise?: Promise<any>
  exports?: any
  evaluated?: boolean
  resolving?: boolean
  code?: string
  map?: EncodedSourceMap
  /**
   * Module ids that imports this module
   */
  importers?: Set<string>
  imports?: Set<string>
}

export class ModuleCacheMap extends Map<string, ModuleCache> {
  normalizePath(fsPath: string) {
    return normalizeModuleId(fsPath)
  }

  /**
   * Assign partial data to the map
   */
  update(fsPath: string, mod: ModuleCache) {
    fsPath = this.normalizePath(fsPath)
    if (!super.has(fsPath)) {
      this.setByModuleId(fsPath, mod)
    }
    else {
      Object.assign(super.get(fsPath) as ModuleCache, mod)
    }
    return this
  }

  setByModuleId(modulePath: string, mod: ModuleCache) {
    return super.set(modulePath, mod)
  }

  set(fsPath: string, mod: ModuleCache) {
    return this.setByModuleId(this.normalizePath(fsPath), mod)
  }

  getByModuleId(modulePath: string) {
    if (!super.has(modulePath)) {
      this.setByModuleId(modulePath, {})
    }

    const mod = super.get(modulePath)!
    if (!mod.imports) {
      Object.assign(mod, {
        imports: new Set(),
        importers: new Set(),
      })
    }
    return mod as ModuleCache &
      Required<Pick<ModuleCache, 'imports' | 'importers'>>
  }

  get(fsPath: string) {
    return this.getByModuleId(this.normalizePath(fsPath))
  }

  deleteByModuleId(modulePath: string): boolean {
    return super.delete(modulePath)
  }

  delete(fsPath: string) {
    return this.deleteByModuleId(this.normalizePath(fsPath))
  }

  invalidateModule(mod: ModuleCache) {
    delete mod.evaluated
    delete mod.resolving
    delete mod.promise
    delete mod.exports
    mod.importers?.clear()
    mod.imports?.clear()
    return true
  }

  /**
   * Invalidate modules that dependent on the given modules, up to the main entry
   */
  invalidateDepTree(
    ids: string[] | Set<string>,
    invalidated = new Set<string>(),
  ) {
    for (const _id of ids) {
      const id = this.normalizePath(_id)
      if (invalidated.has(id)) {
        continue
      }
      invalidated.add(id)
      const mod = super.get(id)
      if (mod?.importers) {
        this.invalidateDepTree(mod.importers, invalidated)
      }
      super.delete(id)
    }
    return invalidated
  }

  /**
   * Invalidate dependency modules of the given modules, down to the bottom-level dependencies
   */
  invalidateSubDepTree(
    ids: string[] | Set<string>,
    invalidated = new Set<string>(),
  ) {
    for (const _id of ids) {
      const id = this.normalizePath(_id)
      if (invalidated.has(id)) {
        continue
      }
      invalidated.add(id)
      const subIds = Array.from(super.entries())
        .filter(([, mod]) => mod.importers?.has(id))
        .map(([key]) => key)
      if (subIds.length) {
        this.invalidateSubDepTree(subIds, invalidated)
      }
      super.delete(id)
    }
    return invalidated
  }

  /**
   * Return parsed source map based on inlined source map of the module
   */
  getSourceMap(id: string) {
    const cache = this.get(id)
    if (cache.map) {
      return cache.map
    }
    const map = cache.code && extractSourceMap(cache.code)
    if (map) {
      cache.map = map
      return map
    }
    return null
  }
}

let SOURCEMAPPING_URL = 'sourceMa';
const VITE_NODE_SOURCEMAPPING_URL = `${SOURCEMAPPING_URL}=data:application/json;charset=utf-8`;
const VITE_NODE_SOURCEMAPPING_REGEXP = new RegExp(
  `//# ${VITE_NODE_SOURCEMAPPING_URL};base64,(.+)`,
);


export function extractSourceMap(code: string): EncodedSourceMap | null {
  const mapString = code.match(VITE_NODE_SOURCEMAPPING_REGEXP)?.[1]
  if (mapString) {
    return JSON.parse(Buffer.from(mapString, 'base64').toString('utf-8'))
  }
  return null
}