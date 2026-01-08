import prisma from './src/config/database.js';

// Give user more credits for testing
async function addCredits() {
    const email = process.argv[2];
    const creditsToAdd = parseInt(process.argv[3]) || 500;

    if (!email) {
        console.log('Usage: node add-credits.js <email> [credits]');
        console.log('Example: node add-credits.js user@example.com 500');
        process.exit(1);
    }

    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, credits: true, plan: true }
    });

    if (!user) {
        console.log(`❌ User not found: ${email}`);
        process.exit(1);
    }

    console.log(`\nCurrent state:`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Plan: ${user.plan}`);
    console.log(`  Credits: ${user.credits}`);

    await prisma.user.update({
        where: { email },
        data: { credits: { increment: creditsToAdd } }
    });

    console.log(`\n✅ Added ${creditsToAdd} credits`);
    console.log(`  New balance: ${user.credits + creditsToAdd} credits`);

    await prisma.$disconnect();
}

addCredits().catch(console.error);
