import type { RequestLogSource } from "src/ts/requestLog"
import type { RequestKind } from "src/ts/status/requestStatus"
import type { ModelModeExtended } from "./shared"

export function toLogSource(mode?: ModelModeExtended): RequestLogSource {
    return toRequestKind(mode)
}

export function toRequestKind(mode?: ModelModeExtended): RequestKind {
    switch (mode) {
        case 'translate': return 'translate'
        case 'memory': return 'memory'
        case 'emotion': return 'emotion'
        case 'submodel':
        case 'otherAx': return 'sub'
        default: return 'main'
    }
}
