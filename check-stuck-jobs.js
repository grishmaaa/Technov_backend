import prisma from './src/config/database.js';

async function checkStuckJobs() {
    console.log('=== Checking Database Status ===\n');

    // Check recent projects
    const projects = await prisma.project.findMany({
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, title: true, status: true, createdAt: true }
    });

    console.log('Recent Projects:');
    projects.forEach(p => {
        console.log(`  ${p.title} - Status: ${p.status} (ID: ${p.id})`);
    });

    // Check recent jobs
    const jobs = await prisma.generationJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, projectId: true, status: true, progress: true, createdAt: true }
    });

    console.log('\nRecent Generation Jobs:');
    jobs.forEach(j => {
        console.log(`  Job ${j.id} - Status: ${j.status}, Progress: ${j.progress}% (Project: ${j.projectId})`);
    });

    // Find stuck jobs (processing for >5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const stuckJobs = await prisma.generationJob.findMany({
        where: {
            status: 'processing',
            createdAt: { lt: fiveMinutesAgo }
        }
    });

    console.log(`\nStuck Jobs (processing > 5min): ${stuckJobs.length}`);

    if (stuckJobs.length > 0) {
        console.log('\nResetting stuck jobs to "pending"...');
        for (const job of stuckJobs) {
            await prisma.generationJob.update({
                where: { id: job.id },
                data: { status: 'pending', progress: 0 }
            });
            console.log(`  ✓ Reset job ${job.id}`);
        }
    }

    await prisma.$disconnect();
}

checkStuckJobs().catch(console.error);
