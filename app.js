const { mkLogger } = require('./logger');
const Service = require('./service');
const logger = mkLogger('bizi-deploy');
const { createJSONRPCErrorResponse } = require('json-rpc-2.0')
const Client = require('./models/client');
const AcmeChallenge = require('./models/acme.challenge');
module.exports = async (cnx) => {
    const AcmeChallenge = require('./models/acme.challenge');
    const svc = new Service({
        akash: {
            accountName: process.env.AKASH_ACCOUNT_NAME
        }
    });
    // await svc.init();

    const express = require('express');
    const bodyParser = require('body-parser');
    const router = express();
    router.use(bodyParser.json());
    router.get("/", (req, res) => res.status(200).json("OK"))
    router.get("/.well-known/acme-challenge/:token", async (req, res) => {
        const { token } = req.params;
        const acmeChallenge = await AcmeChallenge.findOne({
            token
        });
        if (!acmeChallenge) {
            return res.status(404).end("NOT FOUND");
        }
        res.status(200).send(acmeChallenge.keyAuthorization)
    });
    const guard = async (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        const unauthzd = createJSONRPCErrorResponse(req?.body?.id, 401, "unauthorized");
        if (!apiKey) {
            logger.error("Request missing API Key (request headers):", req.headers);
            return res.status(401).json(unauthzd);

        }
        const [key, secret] = apiKey.split('.');
        const client = await Client.findOne({
            key
        });
        if (!client) {
            logger.error("No client found (request headers):", req.headers);
            return res.status(401).json(unauthzd);
        }
        if (!await client.verifySecret(secret)) {
            logger.error("Invalid client secret (request headers):", req.headers);
            return res.status(401).json(unauthzd);
        }
        req.client = client;
        next();
    };
    // rpc.guard = guard;
    router.post("/rpc", guard, async (req, res, next) => {
        const jsonRPCRequest = req.body;
        jsonRPCRequest.client = req.client.id;
        jsonRPCRequest.clientDoc = req.client;
        // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
        // It can also receive an array of requests, in which case it may return an array of responses.
        // Alternatively, you can use server.receiveJSON, which takes JSON string as is (in this case req.body).
        svc.rpc.receive(jsonRPCRequest).then((jsonRPCResponse, ...rest) => {
            if (jsonRPCResponse) {
                res.json(jsonRPCResponse);
            } else {
                logger.debug("Rest of args?", { rest });
                // If response is absent, it was a JSON-RPC notification method.
                // Respond with no content status (204).
                res.sendStatus(204);
            }
        });

    });
    const port = process.env.PORT || 8082;
    const server = router.listen(port);
    server.on('listening', () => {
        logger.info("🤯 listening on port", port, "😎");
    });
    server.on('close', () => {
        logger.info("😎 shutting down gracefully...");
    });
    server.on('error', err => {
        logger.fatal("😯 UNEXPECTED SERVER ERROR:", err);
    });
    process.on('SIGINT', () => {
        server.close(err => {
            if (err) logger.fatal("Failed to shut down server gracefully:", err);
            process.exit(err ? 1 : 0);
        })
    });
}