import prisma from '../config/database.js';

/**
 * New 10-state machine for the 7-stage pipeline.
 * Each stage maps cleanly to a user-visible step in the dashboard.
 */
const ALLOWED_TRANSITIONS = {
    CREATED: ['SCRIPT_GENERATED', 'FAILED'],
    SCRIPT_GENERATED: ['SCRIPT_APPROVED', 'FAILED'],
    SCRIPT_APPROVED: ['CHARACTERS_GENERATED', 'FAILED'],
    CHARACTERS_GENERATED: ['CHARACTERS_APPROVED', 'FAILED'],
    CHARACTERS_APPROVED: ['WORLD_ASSETS_GENERATED', 'FAILED'],
    WORLD_ASSETS_GENERATED: ['WORLD_ASSETS_APPROVED', 'FAILED'],
    WORLD_ASSETS_APPROVED: ['VIDEO_GENERATION', 'FAILED'],
    VIDEO_GENERATION: ['POST_PROCESSING', 'FAILED'],
    POST_PROCESSING: ['COMPLETE', 'FAILED'],
    COMPLETE: ['VIDEO_GENERATION'],     // Allow re-generation
    FAILED: ['VIDEO_GENERATION', 'SCRIPT_GENERATED', 'CREATED'], // Allow retry at various stages
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
