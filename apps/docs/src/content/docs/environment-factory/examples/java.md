---
title: "Java"
description: "Autonoma Environment Factory example with Spring Boot."
---

The Java SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's `inputClass` (a Java class). There is no database introspection, no JDBC executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

## Spring Boot

Uses `AutonomaController` from `ai.autonoma.spring`. Configured as a Spring `@Configuration` bean. The factories use whatever `JdbcTemplate`, JPA repository, or service layer your app already has - the SDK does not need a database connection.

```java
// AutonomaConfig.java
@Configuration
public class AutonomaConfig {

    public record OrganizationInput(String name) {}
    public record UserInput(String email, String name, String organizationId) {}

    @Bean
    public AutonomaController autonomaController() {
        OrganizationRepository organizationRepo = new OrganizationRepository(dataSource);
        UserRepository userRepo = new UserRepository(dataSource);

        HandlerConfig config = new HandlerConfig(
            // The column that scopes all models to a tenant - used to isolate test data
            "organization_id",
            // Shared with Autonoma - verifies incoming requests via HMAC-SHA256
            System.getenv("AUTONOMA_SHARED_SECRET"),
            // Private to your server - signs the refs token so teardown only deletes what was created
            System.getenv("AUTONOMA_SIGNING_SECRET"),
            // Called after `up` - returns credentials so Autonoma can make authenticated requests
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );

        // Every model the dashboard can create needs a factory.
        // The factory's inputClass drives both validation and discover.
        config.setFactories(Map.of(
            "Organization", FactoryUtil.defineFactory(
                OrganizationInput.class,
                (data, ctx) -> organizationRepo.create(data),
                (record, ctx) -> organizationRepo.delete((String) record.get("id"))
            ),
            "User", FactoryUtil.defineFactory(
                UserInput.class,
                (data, ctx) -> userRepo.create(data)
            )
        ));

        return new AutonomaController(config);
    }
}
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/java/spring-boot)

---

## What `inputClass` does

The Java class you pass as the first argument to `defineFactory`:

1. **Drives discover** - the SDK uses reflection to walk the class's declared fields and map Java types to the dashboard's type system. No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK uses Jackson's `ObjectMapper.convertValue` to deserialize the incoming map into an instance of your class. Type mismatches fail validation.
3. **Uses standard Java conventions** - field names come from Jackson `@JsonProperty` annotations (or the field name itself); Java types map to SDK types automatically (`String`→"string", `int/long`→"integer", `double`→"number", `boolean`→"boolean", `Instant`→"timestamp", `UUID`→"uuid").
