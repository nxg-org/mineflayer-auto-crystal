import { Bot, BotEvents } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { EntityController } from "./EntityController";
import { promisify } from "util";
import { performance } from "perf_hooks";
import { oldFindPosition, predictivePositioning, testFindPosition, getEntityAABB } from "../testPlacement";
const sleep = promisify(setTimeout);
const AABB = require("prismarine-physics/lib/aabb");

export interface AutoCrystalRewriteOptionsTwo {
    placementsPerTick: number;
    tpsSync: boolean;
    useOffhand: boolean;
    placementPriority: "damage" | "distance";
    useBackupPosAlgorithm: boolean;
    placeMode: "safe" | "suicide";
    breakMode: "safe" | "suicide";
    maxSelfDamage: number;
    minSelfHealth: number;
    minTargetDamage: number;
    ignoreInventoryCheck: boolean;
    asyncLoadPositions: boolean;
    placeDelay: number;
    placeDistance: number;
    breakDelay: number;
    breakDistance: number;
    logErrors: boolean;
}

export class AutoCrystalRewriteTwo {
    public target: Entity | null = null;
    public placementsPerTick: number;
    public tpsSync: boolean;
    public useOffhand: boolean;
    public placementPriority: "damage" | "distance";
    public useBackupPosAlgorithm: boolean;
    public placeMode: "safe" | "suicide";
    public placeDelay: number;
    public placeDistance: number;
    public breakMode: "safe" | "suicide";
    public breakDelay: number;
    public breakDistance: number;
    public maxSelfDamage: number;
    public minSelfHealth: number;
    public minTargetDamage: number;
    public isRunning: boolean = false;
    public asyncLoadPositions: boolean;
    public holeBlocks = ["bedrock"];
    public fastMode: boolean = true;

    private $enabled: boolean = true;
    private usingBackup: boolean = false;
    private placementPositions: Vec3[] | null = null;
    private wantedPlaced: number = 0;
    private numPlaced: number = 0;
    private numBroke: number = 0;
    private logErrors: boolean;
    private entityController: EntityController;

    private lastPlaceFinish = performance.now();

    public placedCrystals: { [pos: string]: typeof AABB[] } = {};

    constructor(public bot: Bot, options?: Partial<AutoCrystalRewriteOptionsTwo>) {
        this.bot = bot;
        this.placementsPerTick = options?.placementsPerTick ?? 1;
        this.tpsSync = options?.tpsSync ?? false;
        this.useOffhand = options?.useOffhand ?? false;
        this.placementPriority = options?.placementPriority ?? "damage";
        this.useBackupPosAlgorithm = options?.useBackupPosAlgorithm ?? false;
        this.placeMode = options?.placeMode ?? "safe";
        this.placeDelay = options?.placeDelay ?? 1;
        this.placeDistance = options?.placeDistance ?? 4;
        this.breakMode = options?.breakMode ?? "safe";
        this.breakDelay = options?.breakDelay ?? 0;
        this.breakDistance = options?.breakDistance ?? 4;
        this.maxSelfDamage = options?.maxSelfDamage ?? 3;
        this.minSelfHealth = options?.minSelfHealth ?? 12;
        this.minTargetDamage = options?.minTargetDamage ?? 2;
        this.asyncLoadPositions = options?.asyncLoadPositions ?? true;
        this.entityController = new EntityController(bot);

        this.logErrors = options?.logErrors ?? false;
        this.bot.on("AutoCrystalError", console.log);
        this.bot.on("entityGone", (entity: Entity) => {
            this.numBroke++;
        });

        //Switch to ._client.on("entity_spawn")
        this.bot.on("entitySpawn", (entity: Entity) => {
            if (!this.fastMode) return;
            if (!this.isRunning) return;
            if (!entity.name?.includes("_crystal")) return;
            if (this.isBlockGood(entity.position.offset(-0.5, -1, -0.5), this.target)) {
                this.breakCrystal(entity);
            }
        });

        // this.bot.on("entityGone", (entity: Entity) => {
        //     if (!entity.name?.includes("_crystal")) return;
        //     if (this.checkDamage(this.selfDamage(entity.position))) {
        //         this.placeCrystal(entity.position.offset(-0.5, -1, -0.5))
        //     }
        // })
    }

    public set enabled(value: boolean) {
        if (this.$enabled === value) return;
        if (!value) this.isRunning = false;
        this.$enabled = value;
    }

    public get enabled(): boolean {
        return this.$enabled;
    }

    public hasCrystals(): boolean {
        if (this.bot.util.inv.getHandWithItem(this.useOffhand)?.name.includes("_crystal")) return true;
        const handName = this.useOffhand ? "off-hand" : "hand";
        return !!this.bot.util.inv.getAllItemsExceptCurrent(handName).find((item) => item?.name.includes("_crystal"));
    }

    private async equipCrystal(): Promise<boolean> {
        if (this.bot.util.inv.getHandWithItem(this.useOffhand)?.name.includes("_crystal")) return true;
        const handName = this.useOffhand ? "off-hand" : "hand";
        const crystal = this.bot.util.inv.getAllItemsExceptCurrent(handName).find((item) => item?.name.includes("_crystal"));
        if (crystal) {
            await this.bot.equip(crystal, handName);
            //await this.bot.util.builtInsPriority({ group: "inventory", priority: 10 }, this.bot.equip, crystal, handName);
            return !!this.bot.util.inv.getHandWithItem(this.useOffhand)?.name.includes("_crystal");
        }
        return false;
    }

    public getAllCrystals() {
        return Object.values(this.bot.entities).filter((e) => e.name?.includes("_crystal"));
    }

    public getAllValidCrystals(mode: "place" | "break" | "both" = "both") {
        switch (mode) {
            case "both":
                return this.getAllCrystals().filter(
                    (e) =>
                        e.position.distanceTo(this.bot.entity.position) < this.breakDistance ||
                        e.position.distanceTo(this.bot.entity.position) < this.placeDistance
                );
            case "break":
                return this.getAllCrystals().filter((e) => e.position.distanceTo(this.bot.entity.position) < this.breakDistance);
            case "place":
                return this.getAllCrystals().filter((e) => e.position.distanceTo(this.bot.entity.position) < this.placeDistance);
        }
    }

    public getHoles(pos?: Vec3, mode: "defensive" | "passive" | "aggressive" | "retreat" = "passive"): Vec3[] {
        let holes: Vec3[] = [];
        let position = pos ?? this.bot.entity.position;
        if (mode === "retreat") position = this.bot.entity.position.minus(this.bot.entity.position.minus(position));
        const blocks = this.bot.findBlocks({
            point: position,
            maxDistance: 10,
            count: 2000,
            matching: (block) => this.holeBlocks.includes(block?.name),
        });

        for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];
            if (this.isHole(block)) holes.push(block);
        }
        holes = holes.filter((hole) => hole.distanceTo(this.bot.entity.position) >= 2);
        switch (mode) {
            case "aggressive":
                holes = holes.sort((a, b) => a.distanceTo(position) - b.distanceTo(position));
                break;
            case "defensive":
                holes = holes.sort((a, b) => b.distanceTo(position) - a.distanceTo(position));
            case "passive":
                break;
            case "retreat":
                holes = holes.sort((a, b) => b.distanceTo(position) - a.distanceTo(position));
                break;
            default:
                break;
        }
        return holes;
    }

    public isHole(block: Vec3, ...extraNames: string[]) {
        const names = [...extraNames, ...this.holeBlocks];
        // console.log(
        //     this.bot.blockAt(block)?.name,
        // this.bot.blockAt(block.offset(0, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 2, 0))?.name,
        // this.bot.blockAt(block.offset(0, 3, 0))?.name,
        // this.bot.blockAt(block.offset(1, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 1, 1))?.name,
        // this.bot.blockAt(block.offset(-1, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 1, -1))?.name
        // )
        return (
            this.bot.blockAt(block.offset(0, 1, 0))?.name === "air" &&
            this.bot.blockAt(block.offset(0, 2, 0))?.name === "air" &&
            this.bot.blockAt(block.offset(0, 3, 0))?.name === "air" &&
            names.includes(this.bot.blockAt(block.offset(1, 1, 0))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(0, 1, 1))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(-1, 1, 0))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(0, 1, -1))?.name ?? "")
        );
    }

    public isInHole(...extraNames: string[]) {
        return this.isHole(this.bot.entity.position.floored().offset(0, -1, 0), ...extraNames);
    }

    private async loadPositions() {
        if (!this.$enabled || !this.isRunning) return;
        while (this.$enabled && this.isRunning) {
            await this.getPositions();
            await sleep(20);
        }
    }

    private async getPositions() {
        if (this.target) this.placementPositions = await this.findPositions(this.target, this.placementsPerTick);
    }

    public checkSelfDamage(damage: number) {
        return damage <= this.maxSelfDamage && damage < this.bot.health && damage < this.minSelfHealth;
    }

    public checkTargetDamage(damage: number) {
        return damage >= this.minTargetDamage;
    }

    private getDamage(entity: Entity, position: Vec3): number {
        return this.bot.getExplosionDamages(entity, position, 6, false) ?? 0;
    }

    private selfDamage(position: Vec3): number {
        return this.bot.selfExplosionDamages(position, 6, false) ?? 0;
    }

    public filterPositions(positions: Vec3[]) {
        if (this.placeMode === "safe" && this.bot.game.difficulty !== "peaceful" && this.bot.game.gameMode !== "creative" && positions) {
            positions = positions.filter((pos) => this.checkSelfDamage(this.selfDamage(pos.offset(0.5, 1, 0.5))));
        }

        return positions;
    }

    public isBlockGood(pos: Vec3, entity: Entity | null) {
        entity ??= this.target;
        let safeCheck = true;

        if (entity) {
            const selfDamage = this.selfDamage(pos.offset(0.5, 1, 0.5));
            const enemyDamage = this.getDamage(entity, pos.offset(0.5, 1, 0.5));
            if (this.placeMode === "safe" && this.bot.game.difficulty !== "peaceful" && this.bot.game.gameMode !== "creative") {
                safeCheck = this.checkSelfDamage(selfDamage) && selfDamage < enemyDamage;
            }

            return safeCheck && this.checkTargetDamage(enemyDamage);
        }

        return false;
    }

    public isCrystalGood(entity: Entity, mode: "place" | "break" | "both" = "both"): boolean {
        return this.getAllValidCrystals(mode).includes(entity);
    }

    private async findPositions(entity: Entity, number: number = 1, raw: boolean = false, backup?: boolean): Promise<Vec3[] | null> {
        backup ??= this.useBackupPosAlgorithm;
        const entity_position = entity.position.clone();

        // let positions = await testFindPosition(this, entity)
        let positions = backup ? await testFindPosition(this, entity) : await predictivePositioning(this, entity); // await testFindPosition(this, entity)
        if (!positions || positions.length === 0) return null;
        if (raw) return positions;

        if (this.placementPriority === "distance") {
            positions = positions.sort((a, b) => {
                return (
                    b.distanceTo(entity_position) -
                    a.distanceTo(entity_position) -
                    (b.distanceTo(entity_position) - a.distanceTo(entity_position))
                );
            });
            return positions.slice(0, number);
        }

        if (this.placementPriority === "damage") {
            const killPosition = positions.find((pos) => this.getDamage(entity, pos.offset(0.5, 1, 0.5)) >= (entity.health ?? 20));
            if (killPosition) return [killPosition];

            let bestPositions = positions.filter((pos) => this.isBlockGood(pos, entity));
            bestPositions = bestPositions.sort(
                (a, b) => this.getDamage(entity, b.offset(0.5, 1, 0.5)) - this.getDamage(entity, a.offset(0.5, 1, 0.5))
            );

            this.usingBackup = backup;
            if (bestPositions.length === 0 && !backup) return await this.findPositions(entity, number, false, true);
            else if (bestPositions.length === 0 && backup) return null;
            return bestPositions.slice(0, number);
        }

        if (!this.placementPriority || this.placementPriority === "none") {
            return positions.slice(0, number);
        }

        return null;
    }

    public async getPossiblePositions(entity: Entity | null, force: boolean = false): Promise<Vec3[]> {
        entity = entity ?? this.target;
        return entity ? (await this.findPositions(entity, this.placementsPerTick, force)) ?? [] : [];
    }

    private async reportPlaced() {
        while (this.$enabled && this.isRunning) {
            const num = this.numPlaced;
            const want = this.wantedPlaced;
            const broke = this.numBroke;
            const pause = 1000;
            await sleep(pause);
            const placed = this.numPlaced - num;
            const wanted = this.wantedPlaced - want;
            const broken = this.numBroke - broke;
            if (this.isRunning) {
                if (placed !== 0)
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed ${placed} crystals in ${pause} ms. Broke ${broken} crystals. ${
                            (placed / pause) * 1000
                        } pCPS. ${(broken / pause) * 1000} bCPS. ${this.getAllCrystals().length} crystals detected.`
                    );
                else
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed 0 crystals. Attempted to break ${broken} crystals. \nTotal crystals: ${Object.values(
                            this.bot.entities
                        )
                            .filter((e) => e.name?.includes("crystal"))
                            .map((c) => `${c.position}, ${c.id}`)} \ntarget: ${this.target?.username} positions found: ${
                            this.placementPositions?.length
                        }`
                    );
            }
        }
    }

    private addCrystalAABBFromBlock(position: Vec3) {
        position = position.offset(0.5, 1, 0.5);
        const index = position.toString();
        const aabb = getEntityAABB({ position: position, height: 2.01 });
        this.placedCrystals[index] ??= [getEntityAABB({ position: this.bot.entity.position, height: 1 })];
        if (!this.placedCrystals[index].includes(aabb)) this.placedCrystals[index].push(aabb);
    }

    // const latestId = Number(Object.keys(this.bot.entities).sort((a, b) => Number(a) - Number(b))[0]);
    //this.entityController.generateEntity(latestId + 1, 51, position.offset(0.5, 1, 0.5));
    private async placeCrystal(position: Vec3): Promise<boolean> {
        this.wantedPlaced++;
        const entity = this.bot.util.filters.entityAtPosition(position);
        if (entity && entity.isValid) {
            return true;
        } else if (await this.equipCrystal()) {
            const block = this.bot.blockAt(position);
            if (!block || !["obsidian", "bedrock"].includes(block.name)) return false;
            else {
                await this.bot._genericPlace(block, new Vec3(0, 1, 0), { forceLook: true, offhand: this.useOffhand });
                // this.addCrystalAABBFromBlock(position)
                this.numPlaced++;
                // console.log(this.placedCrystals[position.offset(0.5, 1, 0.5).toString()].length)
                return true;
            }
        } else {
            return false;
        }
    }

    private async breakCrystal(entity?: Entity): Promise<boolean> {
        if (!entity) entity = this.bot.util.filters.nearestCrystalFilter() ?? undefined;
        if (!entity) return false;
        else {
            this.bot.lookAt(entity.position, true);
            this.bot.attack(entity);
            this.entityController.destroyEntities(entity.id);
            return true;
        }
    }

    private async breakCrystalFromPos(position: Vec3): Promise<boolean> {
        const entity = this.bot.util.filters.entityAtPosition(position);
        if (!entity) return false;
        else {
            this.bot.lookAt(entity.position, true);
            this.bot.attack(entity);
            this.entityController.destroyEntities(entity.id);
            return true;
        }
    }

    private async syncedPlacements(positions: Vec3[] | null) {
        const target = this.target ?? this.bot.util.filters.allButOtherBotsFilter();
        if (!target || !this.hasCrystals()) return;
        const equipped = await this.equipCrystal();
        if (!equipped) return;
        positions = positions ?? this.placementPositions;
        if (!positions || positions.length === 0) return;
        await Promise.all(positions.map(async (pos) => await this.placeCrystal(pos)));
    }

    private async syncedBreaks(positions: Vec3[] | null = null) {
        if (!positions) {
            await Promise.all(this.getAllValidCrystals("break").map(async (crystal) => await this.breakCrystal(crystal)));
        } else {
            await Promise.all(positions.map(async (pos) => await this.breakCrystalFromPos(pos)));
        }
    }

    private async tpsSyncedStart() {
        let positions: Vec3[] | null = null;
        while (this.$enabled && this.isRunning) {
            if (!this.target || !this.target.isValid) {
                this.target = this.bot.util.filters.allButOtherBotsFilter();
            }
            if (this.target) {
                positions = this.asyncLoadPositions
                    ? this.placementPositions
                    : await this.findPositions(this.target, this.placementsPerTick);

                this.syncedPlacements(positions);
                if (this.placeDelay !== 0) await this.bot.waitForTicks(this.placeDelay);

                this.syncedBreaks();
                if (this.breakDelay !== 0) await this.bot.waitForTicks(this.breakDelay);
            }
            await sleep(0);
        }
    }

    private async test(position: Vec3) {
        const placed = await this.placeCrystal(position);
        await sleep(50);
        if (placed) await this.breakCrystal();
    }

    private async unlockedStart() {
        // let time = performance.now();
        while (this.$enabled && this.isRunning) {
            if (!this.target || !this.target.isValid) {
                this.target = this.bot.util.filters.allButOtherBotsFilter();
            }
            const target = this.target;

            if (!target || !this.hasCrystals()) break;
            const equipped = await this.equipCrystal();
            if (!equipped) break;
            const positions = this.asyncLoadPositions ? this.placementPositions : await this.getPositions();
            if (!positions || positions.length === 0) {
                await sleep(10);
                continue;
            }

            // console.log(positions)
            for (const pos of positions) {
                this.test(pos);
                await sleep(50);
            }
            // await sleep(50 * this.placeDelay - (performance.now() - time))
            // // console.log(performance.now() - time);

            // // for (const pos of positions) {
            // //     await sleep(50);
            // //     this.test(pos)
            // // }
            // this.lastPlaceFinish = performance.now();
            // positions.map(async (pos) => {
            //     const placed = await this.placeCrystal(pos);
            //     if (placed) await this.breakCrystal();
            // });

            // const placements = await Promise.all(positions.map(async (pos) => await this.placeCrystal(pos)));

            // await sleep(50 * this.breakDelay);

            // await Promise.all(
            //     placements.map(async (bool) => {
            //         if (bool) return await this.breakCrystal();
            //     })
            // );

            // time = performance.now()
            // console.log(performance.now() - time);
        }
        this.isRunning = false;
    }

    public start() {
        return this.attack();
    }

    public attack(entity?: Entity) {
        if (!this.enabled || this.isRunning) return false;
        if (!!entity) this.target = entity;

        this.isRunning = true;
        if (this.asyncLoadPositions) this.loadPositions();
        this.tpsSync ? this.tpsSyncedStart() : this.unlockedStart();
        this.reportPlaced();
    }

    public stop() {
        this.isRunning = false;
    }
}
