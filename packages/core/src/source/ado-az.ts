import { execFile } from "node:child_process"

/**
 * The az-CLI data transport for the driver's own Azure DevOps calls (the
 * PR/CI-runs poll sources and the engineering ship gate) — the only way the
 * driver reaches ADO. `az devops invoke` is a raw REST passthrough: it returns
 * the same JSON envelopes (`{ value: [...] }` wrappers included) the service
 * would, so the sources' schema parsing is shared verbatim with what a raw
 * call would need. Auth is the pre-provisioned `AZURE_DEVOPS_EXT_PAT`, which
 * the azure-devops extension honors directly (or an interactive `az login`).
 */

/** One az CLI run: `ok` mirrors the exit code; `body` is stdout (JSON via `--output json`). */
export interface AzResult {
  readonly ok: boolean
  /** Trimmed stderr (or the spawn error) on failure; "OK" on success. */
  readonly statusText: string
  readonly body: string
}

/** Injectable az runner (tests script this; production runs the real CLI). */
export type AzExec = (args: readonly string[]) => Promise<AzResult>

/** Run the real az CLI. Never throws — a spawn/exit failure reads as a non-ok result, like the fetch transports. */
export const execAz: AzExec = (args) =>
  new Promise((resolve) => {
    execFile(
      "az",
      [...args],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve(
          err
            ? { ok: false, statusText: (stderr.trim() || err.message).slice(0, 400), body: "" }
            : { ok: true, statusText: "OK", body: stdout },
        ),
    )
  })

export interface AzInvokeSpec {
  readonly area: string
  readonly resource: string
  /** Organization URL (config `ado.organization`). */
  readonly organization: string
  readonly routeParameters?: Readonly<Record<string, string>>
  readonly queryParameters?: Readonly<Record<string, string>>
  /** Defaults to GET on the az side; the driver's transport never mutates beyond PR creation (native verb). */
  readonly httpMethod?: "GET" | "POST"
}

/** Build the `az devops invoke` argv for a spec. Pure — unit-tested; `execAz` runs it. */
export const azInvokeArgs = (spec: AzInvokeSpec): string[] => [
  "devops",
  "invoke",
  "--area",
  spec.area,
  "--resource",
  spec.resource,
  "--organization",
  spec.organization,
  "--api-version",
  "7.1",
  "--output",
  "json",
  ...(spec.routeParameters && Object.keys(spec.routeParameters).length
    ? ["--route-parameters", ...Object.entries(spec.routeParameters).map(([k, v]) => `${k}=${v}`)]
    : []),
  ...(spec.queryParameters && Object.keys(spec.queryParameters).length
    ? ["--query-parameters", ...Object.entries(spec.queryParameters).map(([k, v]) => `${k}=${v}`)]
    : []),
  ...(spec.httpMethod ? ["--http-method", spec.httpMethod] : []),
]

/** The HTTP-shaped result the fetch-based sources already consume — one parse path for both transports. */
export interface AzHttpShape {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly body: string
}

/** Adapt an az run to the `{ ok, status, statusText, body }` shape the sources' parsers expect. */
export const azToHttp = (r: AzResult): AzHttpShape => ({
  ok: r.ok,
  status: r.ok ? 200 : 0,
  statusText: r.statusText,
  body: r.body,
})
