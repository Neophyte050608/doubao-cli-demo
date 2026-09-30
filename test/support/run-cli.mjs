import {runCli} from '../../src/cli.mjs'

export async function invoke(argv, dependencyOverrides = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    version: '0.1.0',
    stdout: {write: (value) => { stdout += String(value) }},
    stderr: {write: (value) => { stderr += String(value) }},
    ...dependencyOverrides,
  })
  return {code, stdout, stderr}
}
