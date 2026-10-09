#!/bin/bash
# Creates the example WhatsApp event topic and a queue subscribed to it, for eyeballing events.
set -euo pipefail
REGION=ap-south-1
TOPIC_ARN=$(awslocal sns create-topic --region "$REGION" --name eum-whatsapp-events --query TopicArn --output text)
QUEUE_URL=$(awslocal sqs create-queue --region "$REGION" --queue-name eum-whatsapp-events --query QueueUrl --output text)
QUEUE_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sns subscribe --region "$REGION" --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN" --attributes RawMessageDelivery=true
awslocal s3 mb s3://eum-media --region "$REGION" || true
echo "eum-local: topic $TOPIC_ARN -> queue $QUEUE_URL"
