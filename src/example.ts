import { createBot } from "mineflayer";
import autoCrystal from "./index";
import { Vec3 } from "vec3";
import { Entity } from "prismarine-entity";

let target: Entity | null = null;

const bot = createBot({
    username: "pvp-testing",
    host: process.argv[2] ?? "localhost",
    port: Number(process.argv[3]) ?? 25565,
});

bot.loadPlugin(autoCrystal);


bot.on("chat", async (username, message) => {
    const split = message.split(" ");
    switch (split[0]) {
        case "start":
            bot.autoCrystal.stop();
            target = bot.nearestEntity((e) => (e.username ?? e.name) === split[1]);
            if (!target) return console.log("no entity")
            bot.autoCrystal.attack(target);
            break;
        case "stop":
            bot.autoCrystal.stop();
            break;
    }
});
