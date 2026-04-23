---
title: "Python"
description: "Autonoma Environment Factory examples with FastAPI, Flask, and Django."
---

## FastAPI + SQLAlchemy

Uses `create_fastapi_handler` from `autonoma_fastapi` with `sqlalchemy_executor` from `autonoma_sqlalchemy`. Returns an `APIRouter` that you mount on your app.

```python
# app.py
from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_fastapi import create_fastapi_handler
from autonoma_sqlalchemy import sqlalchemy_executor

from database import engine
from repositories.organization import OrganizationRepository
from repositories.user import UserRepository

organization_repo = OrganizationRepository(session)
user_repo = UserRepository(session)

config = HandlerConfig(
    # Connects the SDK to your database through SQLAlchemy
    executor=sqlalchemy_executor(engine),
    # The column that scopes all models to a tenant — used to isolate test data
    scope_field="organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", ""),
    # Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", ""),

    # Factory per model with a dedicated create function in your codebase.
    # Models without a factory (Project, Task) fall back to raw SQL.
    factories={
        # Organization: slug generation, default settings, external services
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create({"name": data["name"]}),
            teardown=lambda record, ctx: organization_repo.delete(record["id"]),
        ),
        # User: password hashing, email normalization
        "User": define_factory(
            create=lambda data, ctx: user_repo.create({
                "email": data["email"],
                "name": data["name"],
                "organization_id": data["organization_id"],
            }),
        ),
    },

    # Called after `up` — returns credentials so Autonoma can make authenticated requests
    auth=lambda user, context: {"headers": {"Authorization": "Bearer test-token"}},
)

router = create_fastapi_handler(config)
app.include_router(router, prefix="/api/autonoma")
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/fastapi-sqlalchemy)

---

## Flask + SQLAlchemy

Same ORM adapter (`sqlalchemy_executor`), different server adapter. `create_flask_handler` returns a Flask Blueprint.

```python
# app.py
from autonoma_flask import create_flask_handler
from autonoma_sqlalchemy import sqlalchemy_executor

# Same HandlerConfig pattern as FastAPI — executor, scope_field,
# secrets, factories, auth. The only difference is the server adapter:
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/flask-sqlalchemy)

---

## Django

Uses Django's native ORM via `django_executor` from `autonoma_django`. The handler is a Django view function.

```python
# core/autonoma_config.py
from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_django import django_executor, create_django_handler

from core.repositories.organization import OrganizationRepository
from core.repositories.user import UserRepository

organization_repo = OrganizationRepository()
user_repo = UserRepository()

config = HandlerConfig(
    # Connects the SDK to your database through Django ORM
    executor=django_executor(),
    # The column that scopes all models to a tenant — used to isolate test data
    scope_field="organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret=os.environ.get("AUTONOMA_SHARED_SECRET", ""),
    # Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret=os.environ.get("AUTONOMA_SIGNING_SECRET", ""),

    # Factory per model with a dedicated create function in your codebase.
    # Models without a factory fall back to raw SQL.
    factories={
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create({"name": data["name"]}),
            teardown=lambda record, ctx: organization_repo.delete(record["id"]),
        ),
        "User": define_factory(
            create=lambda data, ctx: user_repo.create({
                "email": data["email"],
                "name": data["name"],
                "organization_id": data["organization_id"],
            }),
        ),
    },

    # Called after `up` — returns credentials so Autonoma can make authenticated requests
    auth=lambda user, context: {"headers": {"Authorization": "Bearer test-token"}},
)

# Returns a Django view function decorated with @csrf_exempt and @require_POST
handler = create_django_handler(config)
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/django)
