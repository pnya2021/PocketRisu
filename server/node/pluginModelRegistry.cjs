'use strict';

const PIXAI_PROFILE_ID = 'pixai-tagger-v0.9-onnx';
const REPOSITORY = 'deepghs/pixai-tagger-v0.9-onnx';
const REVISION = 'd8cf666911a2c3d10d586d7823259192313c7eb7';
const RESOLVE_PREFIX = `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/`;

const ARTIFACTS = Object.freeze([
    Object.freeze({
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: 'model.onnx',
        url: `${RESOLVE_PREFIX}model.onnx`,
        bytes: 1_271_365_854,
        sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657',
    }),
    Object.freeze({
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: 'selected_tags.csv',
        url: `${RESOLVE_PREFIX}selected_tags.csv`,
        bytes: 596_868,
        sha256: '76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a',
    }),
    Object.freeze({
        profileId: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        name: 'preprocess.json',
        url: `${RESOLVE_PREFIX}preprocess.json`,
        bytes: 557,
        sha256: '5f8303626704053724fa7ac19cd269f57f5f843b6cca314276c8c4d48d335975',
    }),
]);

function requireExactString(value, expected, label) {
    if (typeof value !== 'string' || value !== expected) {
        throw new Error(`Unknown ${label}`);
    }
}

function cloneArtifact(artifact) {
    return Object.freeze({ ...artifact });
}

function getPixaiProfile(profileId) {
    requireExactString(profileId, PIXAI_PROFILE_ID, 'model profile');
    return Object.freeze({
        id: PIXAI_PROFILE_ID,
        repository: REPOSITORY,
        revision: REVISION,
        sourceUrl: `https://huggingface.co/${REPOSITORY}`,
        license: 'Apache-2.0',
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        preprocessing: Object.freeze({
            version: 'pixai-v0.9-preprocess-448-rgb-bilinear-v1',
            width: 448,
            height: 448,
            color: 'rgb',
            resize: 'bilinear',
            labelCount: 13_461,
        }),
        thresholds: Object.freeze({ general: 0.3, character: 0.85 }),
        totalBytes: 1_271_963_279,
        artifacts: Object.freeze(ARTIFACTS.map(cloneArtifact)),
    });
}

function getPixaiArtifact(profileId, artifactName) {
    requireExactString(profileId, PIXAI_PROFILE_ID, 'model profile');
    if (typeof artifactName !== 'string') throw new Error('Unknown model artifact');
    const artifact = ARTIFACTS.find((entry) => entry.name === artifactName);
    if (!artifact) throw new Error('Unknown model artifact');
    return cloneArtifact(artifact);
}

module.exports = {
    PIXAI_PROFILE_ID,
    getPixaiProfile,
    getPixaiArtifact,
};
