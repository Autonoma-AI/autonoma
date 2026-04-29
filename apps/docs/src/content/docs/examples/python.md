---
title: "Python"
description: "Autonoma Environment Factory examples with FastAPI, Flask, and Django."
---

The Python SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's Pydantic `input_model`. There is no database introspection, no ORM executor, and no SQL fallback — your factories own creation, the SDK owns the protocol.

## FastAPI + SQLAlchemy

Uses `create_fastapi_handler` from `autonoma_fastapi`. The factories use whatever SQLAlchemy session your app already has — the SDK does not need a connection.

```python
# app.py
import os
from pydantic import BaseModel, ConfigDict
from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_fastapi import create_fastapi_handler

from database import session
from repositories.organization import OrganizationRepository
from repositories.user import UserRepository

organization_repo = OrganizationRepository(session)
user_repo = UserRepository(session)


class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str


class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str
    name: str
    organization_id: str


config = HandlerConfig(
    # The column that scopes all models to a tenant — used to isolate test data
    scope_field="organization_id",
    # Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    shared_secret=os.environ["AUTONOMA_SHARED_SECRET"],
    # Private to your server — signs the refs token so teardown only deletes what was created
    signing_secret=os.environ["AUTONOMA_SIGNING_SECRET"],

    # Every model the dashboard can create needs a factory.
    # The factory's input_model drives both validation and discover.
    factories={
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create({"name": data.name}),
            teardown=lambda record, ctx: organization_repo.delete(record["id"]),
            input_model=OrganizationInput,
        ),
        "User": define_factory(
            create=lambda data, ctx: user_repo.create({
                "email": data.email,
                "name": data.name,
                "organization_id": data.organization_id,
            }),
            input_model=UserInput,
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

Same `HandlerConfig`, different server adapter. `create_flask_handler` returns a Flask Blueprint.

```python
# app.py
from autonoma_flask import create_flask_handler

# Same HandlerConfig as FastAPI — scope_field, secrets, factories, auth.
# The only difference is the server adapter.
bp = create_flask_handler(config)
app.register_blueprint(bp, url_prefix="/api/autonoma")
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/flask-sqlalchemy)

---

## Django

`create_django_handler` returns a Django view function (already decorated with `@csrf_exempt` + `@require_POST`).

```python
# core/autonoma_config.py
import os
from pydantic import BaseModel, ConfigDict
from autonoma.types import HandlerConfig
from autonoma.factory import define_factory
from autonoma_django import create_django_handler

from core.repositories.organization import OrganizationRepository
from core.repositories.user import UserRepository

organization_repo = OrganizationRepository()
user_repo = UserRepository()


class OrganizationInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str


class UserInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str
    name: str
    organization_id: str


config = HandlerConfig(
    scope_field="organization_id",
    shared_secret=os.environ["AUTONOMA_SHARED_SECRET"],
    signing_secret=os.environ["AUTONOMA_SIGNING_SECRET"],
    factories={
        "Organization": define_factory(
            create=lambda data, ctx: organization_repo.create({"name": data.name}),
            teardown=lambda record, ctx: organization_repo.delete(record["id"]),
            input_model=OrganizationInput,
        ),
        "User": define_factory(
            create=lambda data, ctx: user_repo.create({
                "email": data.email,
                "name": data.name,
                "organization_id": data.organization_id,
            }),
            input_model=UserInput,
        ),
    },
    auth=lambda user, context: {"headers": {"Authorization": "Bearer test-token"}},
)

handler = create_django_handler(config)
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/python/django)

---

## What `input_model` does

The Pydantic class you pass as `input_model`:

1. **Drives discover** — the SDK introspects `model_fields` to describe the model to the dashboard (field names, types, required/optional, defaults). No database introspection runs.
2. **Validates the create payload** — before invoking your `create` function, the SDK calls `input_model.model_validate(payload)` and passes the typed instance in. Your factory body works on a real Python object, not a `dict`.
3. **Lets you accept extras with `extra="ignore"`** — recipes can carry display-only metadata (e.g. `_alias`) without failing validation.

If you also want validated teardown, declare a `ref_model` (a Pydantic class describing the record returned by `create`) and the SDK will call `ref_model.model_validate(record)` before each `teardown` call.
