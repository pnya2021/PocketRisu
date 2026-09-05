// HypaV3 preset shape and factory. Lives apart from hypav3.ts so that the
// memory-preset model (and its unit tests) can build presets without loading
// the summarization engine and its browser-only dependencies.

export interface HypaV3Preset {
    name: string;
    settings: HypaV3Settings;
}

export interface HypaV3Settings {
    summarizationModel: string;
    summarizationPrompt: string;
    reSummarizationPrompt: string;
    memoryTokensRatio: number;
    extraSummarizationRatio: number;
    maxChatsPerSummary: number;
    recentMemoryRatio: number;
    similarMemoryRatio: number;
    enableSimilarityCorrection: boolean;
    preserveOrphanedMemory: boolean;
    processRegexScript: boolean;
    doNotSummarizeUserMessage: boolean;
    summaryChunkSeparator: string;
    // Experimental
    useExperimentalImpl: boolean;
    summarizationRequestsPerMinute: number;
    summarizationMaxConcurrent: number;
    embeddingRequestsPerMinute: number;
    embeddingMaxConcurrent: number;
    alwaysToggleOn: boolean;
    queryChatCount: number;
}

export function createHypaV3Preset(
    name = "New Preset",
    existingSettings = {}
): HypaV3Preset {
    const settings: HypaV3Settings = {
        summarizationModel: "subModel",
        summarizationPrompt: "",
        reSummarizationPrompt: "",
        memoryTokensRatio: 0.2,
        extraSummarizationRatio: 0,
        maxChatsPerSummary: 6,
        recentMemoryRatio: 0.4,
        similarMemoryRatio: 0.4,
        enableSimilarityCorrection: false,
        preserveOrphanedMemory: false,
        processRegexScript: false,
        doNotSummarizeUserMessage: false,
        summaryChunkSeparator: "\\n\\n",
        // Experimental
        useExperimentalImpl: false,
        summarizationRequestsPerMinute: 20,
        summarizationMaxConcurrent: 1,
        embeddingRequestsPerMinute: 100,
        embeddingMaxConcurrent: 1,
        alwaysToggleOn: false,
        queryChatCount: 3,
    };

    if (
        existingSettings &&
        typeof existingSettings === "object" &&
        !Array.isArray(existingSettings)
    ) {
        for (const [key, value] of Object.entries(existingSettings)) {
            if (key in settings && typeof value === typeof settings[key]) {
                settings[key] = value;
            }
        }
    }

    return {
        name,
        settings,
    };
}
