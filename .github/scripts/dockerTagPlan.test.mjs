import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockerTagPlan } from './dockerTagPlan.mjs'

describe('PocketRisu Docker tag routing', () => {
    it('keeps pnya releases in the pnya namespace without legacy publication', () => {
        expect(dockerTagPlan('refs/tags/pnya-v0.1.5', '1234567890abcdef')).toEqual({
            releaseKind: 'pnya',
            version: '0.1.5',
            minor: '0.1',
            isTag: true,
            tagSuffixes: ['pnya-latest', 'pnya-v0.1.5', 'pnya-v0.1'],
            publishLegacy: false,
        })
    })

    it('preserves official release aliases and the required legacy publication', () => {
        expect(dockerTagPlan('refs/tags/v1.10.0', '1234567890abcdef')).toEqual({
            releaseKind: 'official',
            version: '1.10.0',
            minor: '1.10',
            isTag: true,
            tagSuffixes: ['latest', 'v1.10.0', 'v1.10'],
            publishLegacy: true,
        })
    })

    it('keeps manual downstream builds on a commit-specific pnya tag', () => {
        expect(dockerTagPlan('refs/heads/pnya/main', '1234567890abcdef')).toEqual({
            releaseKind: 'manual',
            version: 'pnya-1234567',
            minor: '',
            isTag: false,
            tagSuffixes: ['pnya-1234567'],
            publishLegacy: false,
        })
    })

    it('emits the exact GitHub outputs consumed by the workflow', () => {
        const script = resolve(process.cwd(), '.github/scripts/dockerTagPlan.mjs')
        const result = spawnSync(process.execPath, [script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                DOCKER_RELEASE_REF: 'refs/tags/pnya-v0.1.5',
                DOCKER_RELEASE_SHA: '1234567890abcdef',
            },
        })

        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe([
            'release_kind=pnya',
            'version=0.1.5',
            'minor=0.1',
            'is_tag=true',
            'tag_suffixes=pnya-latest pnya-v0.1.5 pnya-v0.1',
            'publish_legacy=false',
            '',
        ].join('\n'))
    })

    it('checks out the repository in the merge job before executing the tag-plan helper', () => {
        const workflow = readFileSync(
            resolve(process.cwd(), '.github/workflows/docker-build.yml'),
            'utf8',
        ).replace(/\r\n/g, '\n')
        const mergeStart = workflow.indexOf('\n  merge:\n')
        const cleanupStart = workflow.indexOf('\n  cleanup-old-images:\n', mergeStart)
        const mergeJob = workflow.slice(mergeStart, cleanupStart)
        const checkout = mergeJob.search(/uses:\s+actions\/checkout@/)
        const tagPlan = mergeJob.indexOf('node .github/scripts/dockerTagPlan.mjs')

        expect(mergeStart).toBeGreaterThanOrEqual(0)
        expect(cleanupStart).toBeGreaterThan(mergeStart)
        expect(checkout).toBeGreaterThanOrEqual(0)
        expect(tagPlan).toBeGreaterThan(checkout)
    })
})
