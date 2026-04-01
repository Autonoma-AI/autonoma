export default async () => {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
};
