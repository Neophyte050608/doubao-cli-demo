#!/usr/bin/env node

import {createRuntimeDependencies, runCli} from '../src/cli.mjs'

process.exitCode = await runCli(process.argv.slice(2), createRuntimeDependencies())
