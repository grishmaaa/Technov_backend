import prisma from '../config/database.js';

const ALLOWED_TRANSITIONS = {
    CREATED: ['SCENES_GENERATED', 'FAILED'],
    SCENES_GENERATED: ['USER_REVIEW', 'FAILED'],
    USER_REVIEW: ['VISUAL_IDENTITY_DECISION', 'FAILED'],
    VISUAL_IDENTITY_DECISION: ['ASSETS_READY', 'FAILED'],
    ASSETS_READY: ['VIDEO_GENERATION', 'FAILED'],
    VIDEO_GENERATION: ['POST_PROCESSING', 'FAILED'],
    POST_PROCESSING: ['COMPLETE', 'FAILED'],
    COMPLETE: ['VIDEO_GENERATION'], // Allow re-generation
    FAILED: ['VIDEO_GENERATION', 'SCENES_GENERATED'] // Allow retry
};

export const transitionProjectState = async ({
    projectId,
    toState,
    actorType,
    actorId = null,
    reason = null,
    idempotencyKey = null
}) => {
    return await prisma.$transaction(async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId } });
        if (!project) {
            throw new Error(`Project ${projectId} not found`);
        }

        if (idempotencyKey) {
            const existing = await tx.projectStateEvent.findUnique({
                where: { projectId_idempotencyKey: { projectId, idempotencyKey } }
            });
            if (existing) {
                return project;
            }
        }

        if (project.state === toState) {
            return project;
        }

        const allowed = ALLOWED_TRANSITIONS[project.state] || [];
        if (!allowed.includes(toState)) {
            throw new Error(`Invalid project state transition ${project.state} -> ${toState}`);
        }

        const updated = await tx.project.update({
            where: { id: projectId },
            data: {
                state: toState,
                stateVersion: { increment: 1 },
                stateUpdatedAt: new Date()
            }
        });

        await tx.projectStateEvent.create({
            data: {
                projectId,
                fromState: project.state,
                toState,
                actorType,
                actorId,
                reason,
                idempotencyKey
            }
        });

        return updated;
    });
};
