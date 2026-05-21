import type { AddonProvider } from "./provider";

/**
 * Lookup table from provider name (the `provider:` field in `.preview.yaml`)
 * to a registered implementation. Mirrors the shape of `RecipeRegistry` for
 * service recipes — both are plain in-process registries populated at boot.
 */
export class AddonProviderRegistry {
    private readonly providers = new Map<string, AddonProvider>();

    register(provider: AddonProvider): void {
        if (this.providers.has(provider.name)) {
            throw new Error(`Addon provider "${provider.name}" is already registered`);
        }
        this.providers.set(provider.name, provider);
    }

    get(name: string): AddonProvider {
        const provider = this.providers.get(name);
        if (provider == null) {
            const available = [...this.providers.keys()].sort().join(", ") || "(none)";
            throw new Error(`Unknown addon provider "${name}". Available: ${available}`);
        }
        return provider;
    }

    has(name: string): boolean {
        return this.providers.has(name);
    }
}
