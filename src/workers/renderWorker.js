import prisma from '../config/database.js';
import { generateVideo } from '../services/geminiService.js';

export const processGenerationJob = async (jobId) => {
    console.log(`[Worker] Starting Job ${jobId}`);

    try {
        // 1. Fetch Job & Context
        const job = await prisma.generationJob.findUnique({
            where: { id: jobId },
            include: {
                project: {
                    include: { scenes: true }
                }
            }
        });

        if (!job) {
            console.error(`[Worker] Job ${jobId} not found`);
            return;
        }

        const { project } = job;
        const totalScenes = project.scenes.length;

        // Update Status to Processing
        await prisma.generationJob.update({
            where: { id: jobId },
            data: { status: 'processing', progress: 5 }
        });

        // 2. Iterate Scenes
        for (let i = 0; i < totalScenes; i++) {
            const scene = project.scenes[i];
            console.log(`[Worker] Rendering Scene ${scene.orderIndex}...`);

            try {
                // Call Veo Service ("The Anchor")
                // Pass Hero Image (Identity Lock) + Action Description
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

                // Update Job Progress
                const progress = Math.round(((i + 1) / totalScenes) * 90) + 5; // Scale up to 95%
                await prisma.generationJob.update({
                    where: { id: jobId },
                    data: { progress }
                });

            } catch (sceneError) {
                console.error(`[Worker] Failed Scene ${scene.id}:`, sceneError);
                await prisma.scene.update({
                    where: { id: scene.id },
                    data: { status: 'failed', videoUrl: null }
                });
                // Continue to next scene? Or fail job? 
                // For resilience, we continue but mark scene failed.
            }
        }

        // 3. Finalize Job
        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'completed',
                progress: 100
            }
        });

        await prisma.project.update({
            where: { id: project.id },
            data: { status: 'completed' }
        });

        console.log(`[Worker] Job ${jobId} Completed Successfully.`);

    } catch (error) {
        console.error(`[Worker] Critical Job Failure ${jobId}:`, error);
        await prisma.generationJob.update({
            where: { id: jobId },
            data: {
                status: 'failed',
                errorMessage: error.message
            }
        });

        // Optional: Notify DB to show "Retry"
    }
};
