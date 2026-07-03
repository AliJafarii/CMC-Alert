import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CmcCryptoCurrency } from "./cmc.types";

@Injectable()
export class AlertStateService {
  private readonly filePath = join(process.cwd(), "data", "alert-state.json");
  private readonly activeAlertKeys = new Set<string>();

  constructor() {
    this.load();
  }

  isActive(coin: CmcCryptoCurrency): boolean {
    return this.getKeys(coin).some((key) => this.activeAlertKeys.has(key));
  }

  markTriggered(coin: CmcCryptoCurrency): void {
    for (const key of this.getKeys(coin)) {
      this.activeAlertKeys.add(key);
    }
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

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }

    const keys = JSON.parse(readFileSync(this.filePath, "utf8")) as string[];
    this.activeAlertKeys.clear();

    for (const key of keys) {
      this.activeAlertKeys.add(key);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      `${JSON.stringify([...this.activeAlertKeys].sort(), null, 2)}\n`,
    );
  }
}
