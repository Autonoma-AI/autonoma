---
title: "Java"
description: "Autonoma Environment Factory example with Spring Boot + JDBC."
---

## Spring Boot + JDBC

Uses `AutonomaController` from `ai.autonoma.spring` with `JdbcSQLExecutor`. Configured as a Spring `@Configuration` bean.

```java
// AutonomaConfig.java
@Configuration
public class AutonomaConfig {
    @Bean
    public AutonomaController autonomaController(DataSource dataSource) {
        // Connects the SDK to your database through JDBC
        SQLExecutor executor = new JdbcSQLExecutor(dataSource);
        OrganizationRepository organizationRepo = new OrganizationRepository(dataSource);
        UserRepository userRepo = new UserRepository(dataSource);

        HandlerConfig config = new HandlerConfig(
            executor,
            // The column that scopes all models to a tenant — used to isolate test data
            "organization_id",
            // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
            System.getenv("AUTONOMA_SHARED_SECRET"),
            // Private to your server — signs the refs token so teardown only deletes what was created
            System.getenv("AUTONOMA_SIGNING_SECRET"),
            // Called after `up` — returns credentials so Autonoma can make authenticated requests
            (user, context) -> AuthResult.ofHeaders(
                Map.of("Authorization", "Bearer test-token")
            )
        );
        config.setDialect("postgres");

        // Factory per model with a dedicated create function in your codebase.
        // Models without a factory (Project, Task) fall back to raw SQL.
        config.setFactories(Map.of(
            // Organization: slug generation, default settings, external services
            "Organization", FactoryUtil.defineFactory(
                (data, ctx) -> organizationRepo.create(data),
                (record, ctx) -> organizationRepo.delete((String) record.get("id"))
            ),
            // User: password hashing, email normalization
            "User", FactoryUtil.defineFactory(
                (data, ctx) -> userRepo.create(data)
            )
        ));

        return new AutonomaController(config);
    }
}
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/java/spring-boot)
