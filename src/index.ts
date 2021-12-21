import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import customDamageInject from "./util/customDamageCalc";
import { Entity } from "prismarine-entity";
import { AutoCrystal } from "./AutoCrystal";
import type { genericPlaceOptions } from "./types";
import utilPlugin from "@nxg-org/mineflayer-util-plugin"

declare module "mineflayer" {
    interface Bot {
        autoCrystal: AutoCrystal;
        _genericPlace: (referenceBlock: Block, faceVector: Vec3, options: Partial<genericPlaceOptions>) => Promise<Vec3>;
        getExplosionDamages: (targetEntity: Entity, sourcePos: Vec3, power: number, rawDamages?: boolean) => number | null;
        selfExplosionDamages: (sourcePos: Vec3, power: number, rawDamages?: boolean) => number | null;
    }

    interface BotEvents {
        AutoCrystalError: (error: unknown) => void;
    }
}
declare module "prismarine-entity" {
    interface Entity {
        attributes: { [index: string]: { value: number; modifiers: any[] } };
    }
}

// {
//     useBackupPosAlgorithm: true,
//     // careAboutOtherCrystals: false,
//     autoEquip: true,
//     ignoreInventoryCheck: true,
//     asyncLoadPositions: true,
//     logDebug: false,
//     logErrors: false,
//     priority: "damage",
//     placeMode: "safe",
//     breakMode: "safe",
//     damageThreshold: 3,
//     targetDamageThreshold: 1,
//     playerDistance: 5,
//     placeDistance: 3,
//     breakDistance: 3,
//     crystalsPerTick: 1,
//     placeDelay: 0,
//     breakDelay: 0,
// }
export default function inject(bot: Bot) {
    if (!bot.util) bot.loadPlugin(utilPlugin)
    bot.autoCrystal = new AutoCrystal(bot);

    customDamageInject(bot);
}

export {  AutoCrystal } from "./AutoCrystal";
export { genericPlaceOptions };
