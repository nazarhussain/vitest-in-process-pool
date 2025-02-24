# vitest-in-process-pool

---

This package `vitest-in-process-pool` is developed to overcome the issue of running vitest in different JS runtimes other than NodeJS. 

1. This pool loads and process all tests in main process where the vitest is running.
2. There can be issue with performance, so use only when other pools are not working for you.

### Usage

Under the vitest configuration set the `pool` option.

```ts
import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    ...
    pool: "vitest-in-process-pool",
    ...
  },
});
```

Or from console use `--pool vitest-in-process-pool` along with `vitest`.

### Known Issues

**Error: Task instance was not found for suite "testing skipped"**

This is a n known issue and can be resolved by disabling the summary for reporter by adding following reporter configuration.

```json
    reporters: [["default", {"summary": false}]]
```
