import { Block } from "prismarine-block";
import { Entity } from "prismarine-entity";
import mineflayer, { Bot } from "mineflayer";
import pathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { AutoCrystal } from "./AutoCrystal";
import { AutoCrystalRewrite } from "./rewrite/AutoCrystal";
import { AutoCrystalRewriteTwo } from "./rewrite/AutoCrystal2";
import { AABB } from "@nxg-org/mineflayer-util-plugin";



export function getEntityAABB(entity: { position: Vec3; height: number }) {
    const w = entity.height / 2;
    const { x, y, z } = entity.position;
    return new AABB(-w, 0, -w, w, entity.height, w).offset(x, y, z);
}


export async function oldFindPosition(ctx: AutoCrystalRewrite | AutoCrystal | AutoCrystalRewriteTwo, entity: Entity): Promise<Vec3[]> {
    const bot = ctx.bot;
    const entity_position = entity.position;
    return bot.findBlocks({
        point: entity_position,
        maxDistance: 5,
        count: 50,
        matching: (block) => block.name === "obsidian" || block.name === "bedrock",
        //@ts-expect-error
        useExtraInfo: (block: Block) => {
            const isAboveAir =
                bot.blockAt(block.position.offset(0, 1, 0))?.name === "air" && bot.blockAt(block.position.offset(0, 2, 0))?.name === "air";
            const entityDistances =
                block.position.xzDistanceTo(entity_position) <= 90 && block.position.xzDistanceTo(entity_position) >= 1.3;
            const botDistance = bot.entity.position.distanceTo(block.position) <= ctx.placeDistance;
            // const entityClear =
            return isAboveAir && entityDistances && botDistance;
        },
    });
}

// useExtraInfo: (block: Block) => {
//     const isAboveAir =
//         bot.blockAt(block.position.offset(0, 1, 0))?.name === "air" && bot.blockAt(block.position.offset(0, 2, 0))?.name === "air";
//     // const entityDistances =
//     //     block.position.xzDistanceTo(entity_position) <= 90 && block.position.xzDistanceTo(entity_position) >= 1.3;
//     const botDistance = bot.entity.position.distanceTo(block.position) <= ctx.placeDistance;
//     // const { x: aboveX, y: aboveY, z: aboveZ } = block.position.offset(0, 1, 0);
//     const {x: playerX, y: playerY, z: playerZ} = entity.position
//     const blockBoundingBox = new AABB(-0.4, 0, -0.4, 0.4, entity.height, 0.4).offset(playerX, playerY, playerZ)
//     const entityAABBs = (Object.values(bot.entities) as Entity[])
//     .filter((e) => e.name?.includes("_crystal"))
//     .map((et: Entity) => {
//         // taken from taken from https://github.com/PrismarineJS/prismarine-physics/blob/d145e54a4bb8604300258badd7563f59f2101922/index.js#L92
//         const w = et.height / 3;
//         const { x, y, z } = et.position;
//         return new AABB(-w, 0, -w, w, et.height, w).offset(x, y, z);
//     });
//     const hasNoIntersectingEntities = entityAABBs.filter((aabb) => aabb.intersects(blockBoundingBox)).length === 0;
//     // const entityClear =
//     return isAboveAir && botDistance && hasNoIntersectingEntities;
// },

export async function testFindPosition(ctx: AutoCrystalRewrite | AutoCrystal | AutoCrystalRewriteTwo, entity: Entity): Promise<Vec3[]>  {
    const bot = ctx.bot;
    const blockInfoFunc = (block: Block) => {
        if (block.position.distanceTo(bot.entity.position) > ctx.placeDistance) return false;
    
        const hasAirAbove = bot.blockAt(block.position.offset(0, 1, 0))?.name === "air";
        const botNotStandingOnBlock = block.position.xzDistanceTo(bot.entity.position) > 1;
        // const targetNotStandingOnBlock = block.position.xzDistanceTo(entity.position) > 1;
        // do no intersecting entity check
        const { x: aboveX, y: aboveY, z: aboveZ } = block.position.offset(0, 1, 0);
        const blockBoundingBox = new AABB(aboveX, aboveY, aboveZ, aboveX + 0.5, aboveY + 1, aboveZ + 0.5);
        
        // const entityAABBs = [entity].map((entity) => {
        //.filter(e => ["end_crystal", "player"].includes(e.name!)
        const entityAABBs = (Object.values(bot.entities) as Entity[])
            .filter((e) => e.name?.includes("_crystal") || e.name?.includes("player"))
            .map((entity: Entity) => {
                // taken from taken from https://github.com/PrismarineJS/prismarine-physics/blob/d145e54a4bb8604300258badd7563f59f2101922/index.js#L92
                const w = (entity.height) / 2;
                const { x, y, z } = entity.position;
                return new AABB(-w, 0, -w, w, entity.height, w).offset(x, y, z);
            });
        const hasNoIntersectingEntities = entityAABBs.filter((aabb) => aabb.intersects(blockBoundingBox)).length === 0;
        return hasAirAbove && botNotStandingOnBlock  && hasNoIntersectingEntities; //&& targetNotStandingOnBlock


    };

    const findBlocksNearPoint = entity.position;
    // find the crystal
    let blocks = bot.findBlocks({
        point: findBlocksNearPoint,
        matching: (block) => block.name === "obsidian" || block.name === "bedrock",
        //@ts-expect-error
        useExtraInfo: blockInfoFunc,
        maxDistance: 5,
        count: 20
    });
    // if (!blocks) return bot.chat("Couldn't find bedrock or obsidian block that has air above it near myself.");
    // blocks = blocks.sort((a, b) => a.distanceTo(findBlocksNearPoint) - b.distanceTo(findBlocksNearPoint));
    return blocks;
}

/**
 * Logic:
 *  1. Find every possible position for a crystal.
 *  2. Identify top three maximum damage placements.
 *  3. Per each spot identified, load secondary positions based around that crystal SEQUENTIALLY. (Load crystal hitboxes into register.)
 *  4. Compare the total damages of each crystal collection
 *  5. Return highest total damage.
 * @param ctx
 * @param entity
 */
export async function predictivePositioning(ctx: AutoCrystalRewrite | AutoCrystalRewriteTwo, entity: Entity): Promise<Vec3[]>  {
    const bot = ctx.bot;
    const predictedAABBs: { [base: string]: AABB[] } = {};

    let blocks = await testFindPosition(ctx, entity);

    const isValidPosition = (org: Vec3, pos: Vec3) => {
        if (pos.distanceTo(bot.entity.position) > ctx.placeDistance) return false;
        const hasAirAbove = bot.blockAt(pos.offset(0, 1, 0))?.name === "air";
        const botNotStandingOnBlock = pos.xzDistanceTo(bot.entity.position) > 1;
        const targetNotStandingOnBlock = pos.xzDistanceTo(entity.position) > 1;
        const { x: aboveX, y: aboveY, z: aboveZ } = pos.offset(0,  1, 0);
        const blockBoundingBox = new AABB(aboveX - 1, aboveY, aboveZ - 1, aboveX + 1, aboveY + 2, aboveZ + 1);
        // const { x: playerX, y: playerY, z: playerZ } = entity.position;
        // const blockBoundingBox = new AABB(-0.4, 0, -0.4, 0.4, entity.height, 0.4).offset(playerX, playerY, playerZ);
        const entityAABBs = predictedAABBs[org.toString()];

        const hasNoIntersectingEntities = entityAABBs.filter((aabb) => aabb.intersects(blockBoundingBox)).length === 0;
        return hasAirAbove && botNotStandingOnBlock && targetNotStandingOnBlock && hasNoIntersectingEntities;
    };



    function sortBlocksByDamage(positions: Vec3[]) {
        return positions.sort(
            (a, b) =>
                (ctx.bot.getExplosionDamages(entity, b.offset(0.5, 1, 0.5), 6, true) ?? 0) -
                (ctx.bot.getExplosionDamages(entity, a.offset(0.5, 1, 0.5), 6, true) ?? 0)
        );
    }



    blocks = sortBlocksByDamage(blocks);

    let finalFound = blocks.slice(0, 5).map((b) => {
        if (!b) return [];
        const finalBlocks: Vec3[] = [b];
        const index = b.toString();
        predictedAABBs[index] = predictedAABBs[index] ?? [getEntityAABB({position: bot.entity.position, height: 1}), getEntityAABB({ position: b.offset(0.5, 1, 0.5), height: 2.01 })];

        //getEntityAABB(bot.entity)
        for (let i = 1; i < ctx.placementsPerTick && i < blocks.length; i++) {
            let foundBlocks = blocks.filter((bl) => isValidPosition(b, bl));
            foundBlocks = sortBlocksByDamage(foundBlocks);
            const foundBlock = foundBlocks[0];

            if (foundBlock) {
                const foundAABB = getEntityAABB({ position: foundBlock.offset(0.5, 1, 0.5), height: 2.01 });
                if (!predictedAABBs[index].some((aabb) => aabb.equals(foundAABB))) {
                    predictedAABBs[index].push(foundAABB);
                    finalBlocks.push(foundBlock);
                }
            }
        }

        delete predictedAABBs[index];
        return finalBlocks;
    });

    finalFound = finalFound.sort(
        (a, b) =>
            b.map((pos) => ctx.bot.getExplosionDamages(entity, pos.offset(0.5, 1, 0.5), 6, true) ?? 0).reduce((a, b) => a + b) -
            a.map((pos) => ctx.bot.getExplosionDamages(entity, pos.offset(0.5, 1, 0.5), 6, true) ?? 0).reduce((a, b) => a + b)
    );

    // console.log(finalFound[0], ctx.placementsPerTick);
    return finalFound[0];
}
