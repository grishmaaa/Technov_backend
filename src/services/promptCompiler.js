const BASE_ANCHOR = [
    'Cinematic realism',
    'ultra-detailed, filmic 4K render',
    'consistent character identity',
    'stable lighting and clean frames',
    'realistic motion with no flicker or morphing',
    'film-like color grading'
].join(', ');

const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim();

export const compileShotPrompt = ({ scene, shotIndex, shotCount, project, shotDuration }) => {
    const styleHint = project?.imagePrompt ? `Style: ${project.imagePrompt}.` : '';
    const motionHint = scene.motionComplexity ? `Motion intensity: ${scene.motionComplexity}/10.` : '';
    const audioHint = scene.audioDirective ? `Audio mood: ${scene.audioDirective}.` : '';
    const durationHint = shotDuration || scene.duration || 5;
    const shotContext = `Shot ${shotIndex + 1} of ${shotCount}. Duration ${durationHint}s.`;

    const promptParts = [
        BASE_ANCHOR,
        styleHint,
        `Scene: ${scene.actionDescription || scene.promptText}.`,
        motionHint,
        audioHint,
        shotContext
    ].filter(Boolean);

    return normalizeWhitespace(promptParts.join(' '));
};

export const splitSceneIntoShots = ({ scene, maxShotDuration }) => {
    const duration = Math.max(1, scene.duration || maxShotDuration || 5);
    // Single-shot generation to avoid multi-variant/best-of style workflows
    return { shotCount: 1, shotDurations: [duration] };
};
