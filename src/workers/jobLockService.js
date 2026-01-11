export const releaseStaleJobs = async ({ prisma, lockTtlMs, now = new Date() }) => {
    const ttlMs = Number(lockTtlMs);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return 0;
    }

    const threshold = new Date(now.getTime() - ttlMs);
    const baseWhere = {
        status: 'PROCESSING',
        lockedAt: { lt: threshold }
    };
    const baseData = {
        status: 'QUEUED',
        lockedAt: null,
        lockedBy: null,
        startedAt: null
    };

    const withAttempts = await prisma.generationJob.updateMany({
        where: { ...baseWhere, attemptCount: { gt: 0 } },
        data: {
            ...baseData,
            attemptCount: { decrement: 1 }
        }
    });

    const withoutAttempts = await prisma.generationJob.updateMany({
        where: { ...baseWhere, attemptCount: { equals: 0 } },
        data: baseData
    });

    return Number(withAttempts?.count || 0) + Number(withoutAttempts?.count || 0);
};
