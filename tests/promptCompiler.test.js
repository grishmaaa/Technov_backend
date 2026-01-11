import assert from 'node:assert/strict';
import test from 'node:test';
import { compileShotPrompt, splitSceneIntoShots } from '../src/services/promptCompiler.js';

test('splitSceneIntoShots returns a single shot honoring provided duration', () => {
    const scene = { duration: 12 };
    const result = splitSceneIntoShots({ scene, maxShotDuration: 3 });

    assert.equal(result.shotCount, 1, 'should always return a single shot');
    assert.deepEqual(result.shotDurations, [12], 'should keep the scene duration intact');
});

test('splitSceneIntoShots falls back to maxShotDuration or default when duration missing', () => {
    const withMax = splitSceneIntoShots({ scene: {}, maxShotDuration: 3 });
    const withFallback = splitSceneIntoShots({ scene: {}, maxShotDuration: undefined });

    assert.deepEqual(withMax.shotDurations, [3], 'should use provided maxShotDuration when scene duration is absent');
    assert.deepEqual(withFallback.shotDurations, [5], 'should default to 5 seconds when no duration hints are provided');
});

test('compileShotPrompt injects quality anchors and scene context for the single-shot flow', () => {
    const scene = {
        actionDescription: 'A hero walks through a neon-lit alley',
        motionComplexity: 4,
        audioDirective: 'low synth hum'
    };
    const project = { imagePrompt: 'cinematic cyberpunk' };

    const prompt = compileShotPrompt({
        scene,
        shotIndex: 0,
        shotCount: 1,
        project,
        shotDuration: 8
    });

    assert.match(prompt, /ultra-detailed, filmic 4K render/i, 'should include upgraded base anchor');
    assert.match(prompt, /cinematic cyberpunk/i, 'should carry project style hints');
    assert.match(prompt, /Shot 1 of 1\. Duration 8s\./i, 'should mention single-shot context and duration');
    assert.match(prompt, /hero walks through a neon-lit alley/i, 'should include scene description');
});
