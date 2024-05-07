import { SlashCommandBuilder, PermissionFlagsBits, CommandInteraction, User, DiscordAPIError } from 'discord.js';
import { PrismaClient, Prisma } from '@prisma/client';
import { Command } from '../../interfaces/command';
import { handleMemberWarn } from '../../events/onMemberWarn';
import logger from '../../utils/logger';

const prisma = new PrismaClient();

const Warn: Command = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a user')
    .addUserOption((option) => option.setName('user').setDescription('The user to warn').setRequired(true))
    .addStringOption((option) =>
      option.setName('reason').setDescription('The reason for the warning').setRequired(true)
    ),

  async run(interaction: CommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a guild.', ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
      await interaction.reply({ content: 'Insufficient permissions.', ephemeral: true });
      return;
    }

    const userOption = interaction.options.getUser('user', true);
    const reasonOptionRaw = interaction.options.get('reason')?.value;

    if (typeof reasonOptionRaw !== 'string') {
      await interaction.reply({ content: 'The reason must be a string.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUser = await prisma.user.upsert({
        where: { id: userOption.id },
        update: { warns: { increment: 1 } },
        create: { id: userOption.id, warns: 1 },
      });

      const { id } = await prisma.warn.create({
        data: {
          reason: reasonOptionRaw,
          issuerId: interaction.user.id,
          targetId: userOption.id,
        },
      });

      const timeoutDuration = calculateTimeoutDuration(targetUser.warns);
      handleMemberWarn(
        userOption,
        interaction.user,
        reasonOptionRaw,
        targetUser.warns,
        timeoutDuration,
        interaction.guild,
        id
      );

      try {
        const member = await interaction.guild.members.fetch(userOption.id);
        await member.timeout(timeoutDuration, `Accumulated Warns: ${targetUser.warns}`);
      } catch (error) {
        logger.error('Error fetching guild member:', error);
        await interaction.followUp({ content: 'Failed to find the specified user in the guild.' });
        return;
      }

      await sendWarningDM(interaction, userOption, reasonOptionRaw, timeoutDuration);

      await interaction.channel?.send(`<@${userOption.id}> has been warned. Reason: ${reasonOptionRaw}`);
    } catch (error) {
      logger.error('Error processing the warning:', error);
      let errorMessage = 'An error occurred while processing the warning.';
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        errorMessage =
          error.code === 'P2002' ? 'There was a unique constraint violation.' : `Database error: ${error.message}`;
      } else if (error instanceof DiscordAPIError) {
        errorMessage = `Discord API error: ${error.message}`;
      } else if (error instanceof Error && error.name === 'PermissionError') {
        errorMessage = `Permission error: ${error.message}`;
      }
      await interaction.followUp({ content: errorMessage });
    }
  },
};

async function sendWarningDM(
  interaction: CommandInteraction,
  user: User,
  reason: string,
  timeoutDuration: number | null
) {
  let dmMessage = `You have been warned for the following reason: ${reason}.`;

  if (timeoutDuration !== null) {
    dmMessage += `\nAdditionally, you have been placed in timeout for ${timeoutDuration / 60000} minutes due to repeated warnings.`;
  }

  try {
    const dmChannel = await user.createDM();
    await dmChannel.send(dmMessage);
  } catch (err) {
    logger.error('Failed to send DM:', err);
    if (err instanceof DiscordAPIError && err.code === 50007) {
      await interaction.followUp({
        content: `Failed to send a DM to <@${user.id}>. They have been warned, but their DMs are disabled.`,
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: `An error occurred while trying to send a DM: ${err}`,
        ephemeral: true,
      });
    }
  }
}


function calculateTimeoutDuration(warnCount: number): number {
  let minutes;

  switch (warnCount) {
    case 1:
      minutes = 5;
      break;
    case 2:
      minutes = 10;
      break;
    case 3:
      minutes = 60;
      break;
    default:
      minutes = 24 * 60;
      break;
  }

  return minutes * 60000;
}

export default Warn;
