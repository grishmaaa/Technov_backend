import prisma from '../config/database.js';
import { generateVideo } from '../services/geminiService.js';

/**
 * Render Worker - Background Job Processor
 * - Fetches scenes from DB
 * - Calls generateVideo() for each scene
 * - Updates scene.videoUrl
 * - Marks job as completed
 * - SMART RESUME: Skips scenes that already have videos
 */
export const processGenerationJob = async (jobId) => {
    try {
        console.log(`[Worker] Starting Job ${jobId}...`);

        // 1. Fetch Job, Project, and Scenes
        const job = await prisma.generationJob.findUnique({
            where: { id: jobId },
            include: {
                project: {
                    include: {
                        scenes: { orderBy: { orderIndex: 'asc' } }
                    }
                }
            }
        });

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const project = job.project;
        const scenes = project.scenes;
        const totalScenes = scenes.length;

        console.log(`[Worker] Processing Job ${jobId} for Project ${project.id}`);
        console.log(`[Worker] Total Scenes: ${totalScenes}`);

        // Update job status to processing
        await prisma.generationJob.update({
            where: { id: jobId },
            data: { status: 'processing', progress: 5 }
        });

        let completedScenes = 0;
        let skippedScenes = 0;
        let failedScenes = 0;

        // 2. Process Each Scene with Smart Resume
        for (let i = 0; i < totalScenes; i++) {
            const scene = scenes[i];

            try {
                // SMART RESUME: Skip if scene already has video URL
                if (scene.videoUrl) {
                    console.log(`[Worker] ✓ Scene ${scene.orderIndex} already has video, skipping...`);
                    skippedScenes++;
                    completedScenes++;

                    // Update progress
                    const progress = Math.round(((i + 1) / totalScenes) * 90) + 5;
                    await prisma.generationJob.update({
                        where: { id: jobId },
                        data: { progress }
                    });
                    continue;
                }

                console.log(`[Worker] Generating video for Scene ${scene.orderIndex}/${totalScenes}...`);

                // Update scene status to processing
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { status: 'processing' }
                });

                // Generate video using Kling AI
                const { video_url } = await generateVideo(
                    scene.actionDescription,
                    project.heroImageId || ""
                );

                // Update Scene in DB
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: {
                        status: 'completed',
                        videoUrl: video_url
                    }
                });

                completedScenes++;
                console.log(`[Worker] ✓ Scene ${scene.orderIndex} completed (${completedScenes}/${totalScenes})`);

                // Deduct credits for this video (15 credits per scene)
                const VIDEO_COST_PER_SCENE = 15;
                await prisma.user.update({
                    where: { id: project.userId },
                    data: { credits: { decrement: VIDEO_COST_PER_SCENE } }
                });
                console.log(`[Credits] Deducted ${VIDEO_COST_PER_SCENE} credits for scene ${scene.orderIndex}`);

                // Update Job Progress
                const progress = Math.round(((i + 1) / totalScenes) * 90) + 5;
                await prisma.generationJob.update({
                    where: { id: jobId },
                    data: { progress }
                });

            } catch (sceneError) {
                failedScenes++;
                console.error(`[Worker] ✗ Scene ${scene.orderIndex} failed:`, sceneError.message);

                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { status: 'failed', videoUrl: null }
                });
                // Continue to next scene for resilience
            }
        }

        // 3. Determine final job status
        const allScenesProcessed = completedScenes === totalScenes;
        const hasFailures = failedScenes > 0;

        console.log(`\n[Worker] Job Summary:`);
        console.log(`  - Total Scenes: ${totalScenes}`);
        console.log(`  - Completed: ${completedScenes}`);
        console.log(`  - Skipped (already done): ${skippedScenes}`);
        console.log(`  - Failed: ${failedScenes}`);

        let finalStatus = 'completed';
        if (!allScenesProcessed || hasFailures) {
            finalStatus = hasFailures ? 'failed' : 'processing';
        }

        // Update job to final status
        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: finalStatus,
                progress: 100
            }
        });

        // Update project status
        if (allScenesProcessed && !hasFailures) {
            await prisma.project.update({
                where: { id: project.id },
                data: {
                    status: 'completed',
                    finalVideoUrl: scenes[0]?.videoUrl || null
                }
            });
            console.log(`[Worker] ✅ Project ${project.id} marked as completed!`);
        } else if (hasFailures) {
            console.log(`[Worker] ⚠️ Job completed with ${failedScenes} failures. You can re-run to retry failed scenes.`);
        }

        console.log(`[Worker] Job ${jobId} finished.`);

    } catch (error) {
        console.error(`[Worker] Critical Job Failure ${jobId}:`, error);
        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'failed',
                errorMessage: error.message
            }
        });
    }
};
