import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CmcCryptoCurrency } from "./cmc.types";

interface AlertStateFile {
  activeKeys?: string[];
  cooldowns?: Record<string, string>;
}

@Injectable()
export class AlertStateService {
  private readonly logger = new Logger(AlertStateService.name);
  private readonly filePath = join(process.cwd(), "data", "alert-state.json");
  private readonly activeAlertKeys = new Set<string>();
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {
    const migrated = this.load();

    if (migrated) {
      this.save();
    }
  }

  isActive(coin: CmcCryptoCurrency): boolean {
    return this.getKeys(coin).some((key) => this.activeAlertKeys.has(key));
  }

  isCoolingDown(coin: CmcCryptoCurrency): boolean {
    const now = Date.now();
    this.pruneExpiredCooldowns(now);

    return this.getKeys(coin).some((key) => {
      const lastTriggeredAt = this.cooldowns.get(key);
      return (
        lastTriggeredAt !== undefined &&
        now - lastTriggeredAt < this.getCooldownMs()
      );
    });
  }

  markTriggered(coin: CmcCryptoCurrency): void {
    const now = Date.now();

    for (const key of this.getKeys(coin)) {
      this.activeAlertKeys.add(key);
      this.cooldowns.set(key, now);
    }

    this.pruneExpiredCooldowns(now);
    this.save();
  }

  markRecovered(coin: CmcCryptoCurrency): void {
    for (const key of this.getKeys(coin)) {
      this.activeAlertKeys.delete(key);
    }

    this.save();
  }

  private getKeys(coin: CmcCryptoCurrency): string[] {
    return [
      `${coin.source ?? "CoinMarketCap"}:${coin.id}`,
      `slug:${coin.slug.toLowerCase()}`,
      `name:${coin.name.toLowerCase()}`,
    ];
  }

  private getCooldownMs(): number {
    const hours = Number(
      this.configService.get<string>("CMC_ALERT_COOLDOWN_HOURS") ?? "24",
    );
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 24;

    return safeHours * 60 * 60 * 1000;
  }

  private pruneExpiredCooldowns(now = Date.now()): void {
    const cooldownMs = this.getCooldownMs();

    for (const [key, lastTriggeredAt] of this.cooldowns.entries()) {
      if (
        !Number.isFinite(lastTriggeredAt) ||
        now - lastTriggeredAt > cooldownMs
      ) {
        this.cooldowns.delete(key);
      }
    }
  }

  private load(): boolean {
    if (!existsSync(this.filePath)) {
      return false;
    }

    const rawState = readFileSync(this.filePath, "utf8").trim();

    if (!rawState) {
      return false;
    }

    let parsedState: AlertStateFile | string[];

    try {
      parsedState = JSON.parse(rawState) as AlertStateFile | string[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Ignoring invalid alert state file: ${message}`);
      return false;
    }

    this.activeAlertKeys.clear();
    this.cooldowns.clear();

    if (Array.isArray(parsedState)) {
      const now = Date.now();

      for (const key of parsedState) {
        this.activeAlertKeys.add(key);
        this.cooldowns.set(key, now);
      }

      return true;
    }

    for (const key of parsedState.activeKeys ?? []) {
      this.activeAlertKeys.add(key);
    }

    for (const [key, value] of Object.entries(parsedState.cooldowns ?? {})) {
      const timestamp = new Date(value).getTime();

      if (Number.isFinite(timestamp)) {
        this.cooldowns.set(key, timestamp);
      }
    }

    this.pruneExpiredCooldowns();
    return false;
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;

    writeFileSync(
      tempPath,
      `${JSON.stringify(
        {
          activeKeys: [...this.activeAlertKeys].sort(),
          cooldowns: Object.fromEntries(
            [...this.cooldowns.entries()]
              .sort(([first], [second]) => first.localeCompare(second))
              .map(([key, timestamp]) => [
                key,
                new Date(timestamp).toISOString(),
              ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    renameSync(tempPath, this.filePath);
  }
}
