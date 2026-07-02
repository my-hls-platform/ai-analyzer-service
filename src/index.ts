import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { SQSEvent } from 'aws-lambda'
import ffmpeg from 'fluent-ffmpeg'
import * as fs from 'fs'
import * as path from 'path'

const isLocal = process.env.AWS_SAM_LOCAL || !process.env.LAMBDA_TASK_ROOT
if (isLocal) ffmpeg.setFfmpegPath('/var/task/ffmpeg')
else ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path)

const bedrockClient = new BedrockRuntimeClient({})
const eventBridgeClient = new EventBridgeClient({})

export const handler = async (event: SQSEvent) => {
	console.log('Received Event:', JSON.stringify(event, null, 2))

	const sqsMessage = event.Records[0].body
	const { originalKey, hlsUrl } = JSON.parse(sqsMessage).detail

	const cloudfrontDomain = process.env.CLOUDFRONT_URL
	if (!cloudfrontDomain)
		throw new Error('CLOUDFRONT_URL is not set in environment variables')

	const fullStreamUrl = `${cloudfrontDomain}/${hlsUrl}`
	const framePath = path.join('/tmp', `frame_${Date.now()}.jpg`)

	try {
		console.log(`Extracting frame from stream: ${fullStreamUrl}`)
		await new Promise((resolve, reject) => {
			ffmpeg(fullStreamUrl)
				.outputOptions(['-vframes 1', '-q:v 2', '-ss 00:00:02'])
				.output(framePath)
				.on('end', resolve)
				.on('error', reject)
				.run()
		})

		const imageBuffer = fs.readFileSync(framePath)
		const base64Image = imageBuffer.toString('base64')
		console.log('Frame extracted and converted to Base64.')

		const prompt = `Act as an expert content creator. Analyze this exact frame from the video and write a highly engaging, 2-sentence SEO description for it. Focus on what is visually happening.`

		const bedrockCommand = new InvokeModelCommand({
			modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
			body: JSON.stringify({
				anthropic_version: 'bedrock-2023-05-31',
				max_tokens: 500,
				messages: [
					{
						role: 'user',
						content: [
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/jpeg',
									data: base64Image,
								},
							},
							{
								type: 'text',
								text: prompt,
							},
						],
					},
				],
			}),
			contentType: 'application/json',
		})
		console.log('Sending frame to Claude 3 Sonnet...')

		const response = await bedrockClient.send(bedrockCommand)
		const responseBody = JSON.parse(new TextDecoder().decode(response.body))
		const generatedDescription = responseBody.content[0].text

		console.log('Generated Description:', generatedDescription)

		await eventBridgeClient.send(
			new PutEventsCommand({
				Entries: [
					{
						Source: 'hls-platform.ai-analyzer',
						DetailType: 'Video.Analyzed',
						Detail: JSON.stringify({
							originalKey,
							description: generatedDescription,
						}),
						EventBusName: 'default',
					},
				],
			}),
		)

		return { statusCode: 200, body: 'Success' }
	} catch (error) {
		console.error('Error processing AI analysis:', error)
		throw error
	} finally {
		if (fs.existsSync(framePath)) fs.unlinkSync(framePath)
	}
}
