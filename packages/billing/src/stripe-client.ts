import Stripe from "stripe";
import { env } from "./env";

let instance: Stripe | undefined;

export function getStripe(): Stripe {
    if (env.STRIPE_SECRET_KEY == null) {
        throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    if (instance == null) {
        instance = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" });
    }
    return instance;
}
