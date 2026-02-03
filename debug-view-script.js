
import prisma from './src/config/database.js';

async function viewLatestScript() {
    try {
        const project = await prisma.project.findFirst({
            orderBy: { updatedAt: 'desc' },
            include: { scenes: { orderBy: { orderIndex: 'asc' } } }
        });

        if (!project) {
            console.log("No projects found.");
            return;
        }

        console.log(`\n=== PROJECT: ${project.title} ===`);
        console.log(`ID: ${project.id}`);
        console.log(`Duration: ${project.scenes.length * 8}s approx (${project.scenes.length} scenes)`);
        console.log(`State: ${project.state}`);
        console.log("\n--- SCRIPT / SCENES ---");

        project.scenes.forEach(scene => {
            console.log(`\n[Scene ${scene.orderIndex}]`);
            console.log(`Action: ${scene.actionDescription || scene.promptText}`);
            console.log(`Duration: ${scene.duration}s`);
            console.log(`Video URL: ${scene.videoUrl || 'PENDING'}`);
        });

    } catch (error) {
        console.error("Error fetching script:", error);
    } finally {
        await prisma.$disconnect();
    }
}

viewLatestScript();
