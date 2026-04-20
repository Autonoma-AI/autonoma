import { PostgresRecipe } from "./postgres-recipe";
import type { Recipe } from "./recipe";
import { RedisRecipe } from "./redis-recipe";
import { TemporalRecipe } from "./temporal-recipe";

export class RecipeRegistry {
    private recipes = new Map<string, Recipe>();

    constructor() {
        this.register(new PostgresRecipe());
        this.register(new RedisRecipe());
        this.register(new TemporalRecipe());
    }

    register(recipe: Recipe): void {
        this.recipes.set(recipe.name, recipe);
    }

    get(name: string): Recipe {
        const recipe = this.recipes.get(name);
        if (!recipe) {
            throw new Error(`Unknown recipe "${name}". Available: ${[...this.recipes.keys()].join(", ")}`);
        }
        return recipe;
    }

    has(name: string): boolean {
        return this.recipes.has(name);
    }

    list(): string[] {
        return [...this.recipes.keys()];
    }
}
