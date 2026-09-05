// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('portable and Docker server runtime dependencies', () => {
    let outputDirectory: string
    let generated: { dependencies: Record<string, string> }

    beforeAll(() => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'pocket-server-deps-'))
        execFileSync(process.execPath, [
            resolve('scripts/portable/gen-server-deps.cjs'),
            process.cwd(),
            outputDirectory,
        ], { encoding: 'utf8' })
        generated = JSON.parse(readFileSync(join(outputDirectory, 'package.json'), 'utf8'))
    })

    afterAll(() => {
        if (outputDirectory && dirname(resolve(outputDirectory)) === resolve(tmpdir())
            && basename(outputDirectory).startsWith('pocket-server-deps-')) {
            rmSync(outputDirectory, { recursive: true, force: true })
        }
    })

    it('ships the PixAI worker dependencies even though the worker is not imported by the server', () => {
        expect(Object.keys(generated.dependencies)).toEqual(expect.arrayContaining([
            'onnxruntime-node',
            'sharp',
        ]))
        expect(generated.dependencies).not.toHaveProperty('svelte')
    })

    it('keeps the committed frozen-install package consistent with the generated server closure', () => {
        const committed = JSON.parse(readFileSync('scripts/portable/server-deps/package.json', 'utf8'))
        expect(committed).toEqual(generated)
    })
})
