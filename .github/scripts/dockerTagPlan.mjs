import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function releaseVersion(ref, prefix) {
    const version = ref.slice(prefix.length)
    if (!version) throw new Error(`Docker release ref is missing a version: ${ref}`)
    const separator = version.lastIndexOf('.')
    return {
        version,
        minor: separator === -1 ? version : version.slice(0, separator),
    }
}

export function dockerTagPlan(ref, sha) {
    if (ref.startsWith('refs/tags/pnya-v')) {
        const { version, minor } = releaseVersion(ref, 'refs/tags/pnya-v')
        return {
            releaseKind: 'pnya',
            version,
            minor,
            isTag: true,
            tagSuffixes: ['pnya-latest', `pnya-v${version}`, `pnya-v${minor}`],
            publishLegacy: false,
        }
    }
    if (ref.startsWith('refs/tags/v')) {
        const { version, minor } = releaseVersion(ref, 'refs/tags/v')
        return {
            releaseKind: 'official',
            version,
            minor,
            isTag: true,
            tagSuffixes: ['latest', `v${version}`, `v${minor}`],
            publishLegacy: true,
        }
    }
    if (!sha) throw new Error('Docker workflow dispatch is missing a commit SHA')
    const version = `pnya-${sha.slice(0, 7)}`
    return {
        releaseKind: 'manual',
        version,
        minor: '',
        isTag: false,
        tagSuffixes: [version],
        publishLegacy: false,
    }
}

function printGitHubOutputs(plan) {
    console.log(`release_kind=${plan.releaseKind}`)
    console.log(`version=${plan.version}`)
    console.log(`minor=${plan.minor}`)
    console.log(`is_tag=${plan.isTag}`)
    console.log(`tag_suffixes=${plan.tagSuffixes.join(' ')}`)
    console.log(`publish_legacy=${plan.publishLegacy}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    printGitHubOutputs(dockerTagPlan(
        process.env.DOCKER_RELEASE_REF ?? '',
        process.env.DOCKER_RELEASE_SHA ?? '',
    ))
}
