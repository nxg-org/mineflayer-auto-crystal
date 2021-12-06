import { Effects } from "minecraft-data";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Item, NormalizedEnchant } from "prismarine-item";
import md from "minecraft-data"
import { Vec3 } from "vec3";

const armorPieces = ["head", "torso", "legs", "feet"];

// https://minecraft.fandom.com/wiki/Explosion
// Use bot.world, there's no typing yet.
function calcExposure(playerPos: Vec3, explosionPos: Vec3, world: any) {
    const dx = 1 / (0.6 * 2 + 1);
    const dy = 1 / (1.8 * 2 + 1);
    const dz = 1 / (0.6 * 2 + 1);

    const d3 = (1 - Math.floor(1 / dx) * dx) / 2;
    const d4 = (1 - Math.floor(1 / dz) * dz) / 2;

    let sampled = 0;
    let exposed = 0;
    const pos = new Vec3(0, 0, 0);
    for (pos.y = playerPos.y; pos.y <= playerPos.y + 1.8; pos.y += 1.8 * dy) {
        for (pos.x = playerPos.x - 0.3 + d3; pos.x <= playerPos.x + 0.3; pos.x += 0.6 * dx) {
            for (pos.z = playerPos.z - 0.3 + d4; pos.z <= playerPos.z + 0.3; pos.z += 0.6 * dz) {
                const dir = pos.minus(explosionPos);
                const range = dir.norm();
                if (world.raycast(explosionPos, dir.normalize(), range) === null) {
                    exposed++;
                }
                sampled++;
            }
        }
    }
    return exposed / sampled;
}

// https://minecraft.fandom.com/wiki/Armor#Damage_protection
function getDamageAfterAbsorb(damages: number, armorValue: number, toughness: number) {
    const var3 = 2 + toughness / 4;
    const var4 = Math.min(Math.max(armorValue - damages / var3, armorValue * 0.2), 20);
    return damages * (1 - var4 / 25);
}

// https://minecraft.fandom.com/wiki/Attribute#Operations
function getAttributeValue(prop: any) {
    let X = prop.value;
    for (const mod of prop.modifiers) {
        if (mod.operation !== 0) continue;
        X += mod.amount;
    }
    let Y = X;
    for (const mod of prop.modifiers) {
        if (mod.operation !== 1) continue;
        Y += X * mod.amount;
    }
    for (const mod of prop.modifiers) {
        if (mod.operation !== 2) continue;
        Y += Y * mod.amount;
    }
    return Y;
}

function getDamageWithEnchantments(damage: number, equipment: Item[]) {
    const enchantments = equipment.some((e) => !!e)
        ? equipment
              .map((armor) =>
                  armor?.enchants
                      .map((enchant: NormalizedEnchant) =>
                          enchant?.name === "protection" ? enchant.lvl : enchant?.name === "blast_protection" ? enchant.lvl * 2 : 0
                      ) 
                      .reduce((b: number, a: number) => b + a, 0) ?? [0]
              )
              .reduce((b: number, a: number) => b + a, 0)
        : 0;
    return damage * (1 - Math.min(enchantments, 20) / 25);
}



export default function customDamageInject(bot: Bot) {
    const effects = md(bot.version).effects
    let resistanceIndex = "11";
    for (const effectId in effects) {
        const effect = effects[effectId] 
        if (effect.name.includes("resistance")) {
            resistanceIndex = effectId
            break;
        }
    }
    const damageMultiplier = 8; // for 1.12+ 8 for 1.8 TODO check when the change occur (likely 1.9)
    const armorThoughnessKey = "generic.armorToughness"; // was renamed in 1.16
    const armorProtectionKey = "generic.armor"

    const difficultyValues = {
        peaceful: 0,
        easy: 1,
        normal: 2,
        hard: 3,
    };

    //There's a mistyping in mineflayer. Effect[] is not accurate. You cannot map over it.
    function getDamageWithEffects(damage: number, effects: {[id: string]: {id: number, amplifier: number, duration: number}}){
        const resistanceLevel = effects?.[resistanceIndex]?.amplifier ?? 0
        return damage * (1 - resistanceLevel / 5)
    }

    bot.selfExplosionDamages = (sourcePos: Vec3, power: number, rawDamages = false) => {
        const distance = bot.entity.position.distanceTo(sourcePos);
        const radius = 2 * power;
        if (distance >= radius) return 0;
        const exposure = calcExposure(bot.entity.position, sourcePos, bot.world);
        const impact = (1 - distance / radius) * exposure;
        let damages = Math.floor((impact * impact + impact) * damageMultiplier * power + 1);
        // The following modifiers are constant for the input bot.entity and doesnt depend
        // on the source position, so if the goal is to compare between positions they can be
        // ignored to save computations
        if (!rawDamages && bot.entity.attributes[armorProtectionKey]) {
            const armor = getAttributeValue(bot.entity.attributes[armorProtectionKey]);
            const armorToughness = getAttributeValue(bot.entity.attributes[armorThoughnessKey]);
            damages = getDamageAfterAbsorb(damages, armor, armorToughness);
            const equipment = armorPieces.map((piece) => bot.inventory.slots[bot.getEquipmentDestSlot(piece)]);
            damages = getDamageWithEnchantments(damages, equipment);
            damages = getDamageWithEffects(damages, bot.entity.effects as any)
            damages *= difficultyValues[bot.game.difficulty] * 0.5;
        } else if (!rawDamages && !bot.entity.attributes[armorProtectionKey]) {
            return null;
        }
        return Math.floor(damages);
    };

    bot.getExplosionDamages = (targetEntity: Entity, sourcePos: Vec3, power: number, rawDamages = false) => {
        const distance = targetEntity.position.distanceTo(sourcePos);
        const radius = 2 * power;
        if (distance >= radius) return 0;
        const exposure = calcExposure(targetEntity.position, sourcePos, bot.world);
        const impact = (1 - distance / radius) * exposure;
        let damages = Math.floor((impact * impact + impact) * damageMultiplier * power + 1);
        // The following modifiers are constant for the input targetEntity and doesnt depend
        // on the source position, so if the goal is to compare between positions they can be
        // ignored to save computations
        if (!rawDamages && targetEntity.attributes[armorProtectionKey]) {
            const armor = getAttributeValue(targetEntity.attributes[armorProtectionKey]);
            const armorToughness = getAttributeValue(targetEntity.attributes[armorThoughnessKey]);
            damages = getDamageAfterAbsorb(damages, armor, armorToughness);
            damages = getDamageWithEnchantments(damages, targetEntity.equipment);
            damages = getDamageWithEffects(damages, targetEntity.effects as any)

            // console.log(targetEntity.username, targetEntity.equipment, damages)
            // const allEnchants = allButCheckingArmor.map(armor => armor.enchants.map(enchantFunc).reduce(add, 0)).reduce(add, 0) + enchantments.map(enchantFunc).reduce(add, 0)
            // TODO: protection enchantment and resistance effects

            if (targetEntity.type === "player") {
                damages *= difficultyValues[bot.game.difficulty] * 0.5;
            }
        } else if (!rawDamages && !targetEntity.attributes[armorProtectionKey]) {
            return null;
        }
        return Math.floor(damages);
    };

}
